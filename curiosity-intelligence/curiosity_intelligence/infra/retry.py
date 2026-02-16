"""
Retry and Rate Limiting

Provides decorators for resilient API calls with:
- Exponential backoff
- Jitter to prevent thundering herd
- Circuit breaker pattern
- Rate limiting per service
"""

import asyncio
import time
from functools import wraps
from typing import Callable, Optional, Type, Tuple
from dataclasses import dataclass, field
from collections import defaultdict

from tenacity import (
    retry,
    stop_after_attempt,
    wait_exponential_jitter,
    retry_if_exception_type,
    before_sleep_log,
    RetryError,
)
import structlog

logger = structlog.get_logger()


# ============================================
# RETRY CONFIGURATION
# ============================================

@dataclass
class RetryConfig:
    """Configuration for retry behavior."""
    max_attempts: int = 5
    min_wait: float = 1.0  # seconds
    max_wait: float = 60.0  # seconds
    jitter: float = 1.0  # seconds of random jitter
    retryable_exceptions: Tuple[Type[Exception], ...] = (
        ConnectionError,
        TimeoutError,
        asyncio.TimeoutError,
    )


# Default configs per service
RETRY_CONFIGS = {
    "reddit": RetryConfig(max_attempts=3, min_wait=2.0, max_wait=30.0),
    "stackexchange": RetryConfig(max_attempts=5, min_wait=1.0, max_wait=60.0),
    "openai": RetryConfig(max_attempts=5, min_wait=2.0, max_wait=120.0),
    "newsapi": RetryConfig(max_attempts=3, min_wait=1.0, max_wait=30.0),
    "default": RetryConfig(),
}


def with_retry(
    service: str = "default",
    config: Optional[RetryConfig] = None,
):
    """
    Decorator that adds retry logic to async functions.
    
    Usage:
        @with_retry("openai")
        async def embed_text(text: str) -> list:
            ...
    """
    cfg = config or RETRY_CONFIGS.get(service, RETRY_CONFIGS["default"])
    
    def decorator(func: Callable):
        @wraps(func)
        async def wrapper(*args, **kwargs):
            attempt = 0
            last_exception = None
            
            while attempt < cfg.max_attempts:
                try:
                    return await func(*args, **kwargs)
                except cfg.retryable_exceptions as e:
                    attempt += 1
                    last_exception = e
                    
                    if attempt >= cfg.max_attempts:
                        logger.error(
                            "max_retries_exceeded",
                            service=service,
                            function=func.__name__,
                            attempts=attempt,
                            error=str(e),
                        )
                        raise
                    
                    # Calculate wait with exponential backoff + jitter
                    wait = min(
                        cfg.max_wait,
                        cfg.min_wait * (2 ** (attempt - 1))
                    )
                    wait += (time.time() % 1) * cfg.jitter  # Add jitter
                    
                    logger.warning(
                        "retrying_after_error",
                        service=service,
                        function=func.__name__,
                        attempt=attempt,
                        wait_seconds=round(wait, 2),
                        error=str(e),
                    )
                    
                    await asyncio.sleep(wait)
                except Exception as e:
                    # Non-retryable exception
                    logger.error(
                        "non_retryable_error",
                        service=service,
                        function=func.__name__,
                        error=str(e),
                        error_type=type(e).__name__,
                    )
                    raise
            
            raise last_exception
        
        return wrapper
    return decorator


# ============================================
# RATE LIMITER
# ============================================

@dataclass
class RateLimitConfig:
    """Configuration for rate limiting."""
    requests_per_second: float = 10.0
    requests_per_minute: float = 100.0
    requests_per_day: float = 10000.0
    burst_size: int = 10


RATE_LIMITS = {
    "reddit": RateLimitConfig(
        requests_per_second=1.0,  # PRAW default
        requests_per_minute=60.0,
    ),
    "stackexchange": RateLimitConfig(
        requests_per_second=30.0,
        requests_per_day=10000.0,  # Without API key
    ),
    "openai": RateLimitConfig(
        requests_per_minute=500.0,  # Tier 1
        requests_per_second=10.0,
    ),
    "newsapi": RateLimitConfig(
        requests_per_day=100.0,  # Free tier
        requests_per_second=1.0,
    ),
}


class RateLimiter:
    """
    Token bucket rate limiter with multiple time windows.
    
    Usage:
        limiter = RateLimiter("openai")
        await limiter.acquire()
        # make API call
    """
    
    def __init__(self, service: str):
        self.service = service
        self.config = RATE_LIMITS.get(service, RateLimitConfig())
        
        # Token buckets for different time windows
        self._tokens_second = self.config.burst_size
        self._tokens_minute = self.config.requests_per_minute
        self._tokens_day = self.config.requests_per_day
        
        self._last_update = time.time()
        self._lock = asyncio.Lock()
        
        # Stats
        self._total_requests = 0
        self._total_waits = 0
    
    async def acquire(self, tokens: int = 1) -> float:
        """
        Acquire tokens, waiting if necessary.
        
        Returns:
            Wait time in seconds (0 if no wait needed)
        """
        async with self._lock:
            now = time.time()
            elapsed = now - self._last_update
            self._last_update = now
            
            # Refill tokens
            self._tokens_second = min(
                self.config.burst_size,
                self._tokens_second + elapsed * self.config.requests_per_second
            )
            self._tokens_minute = min(
                self.config.requests_per_minute,
                self._tokens_minute + elapsed * (self.config.requests_per_minute / 60)
            )
            
            # Check if we need to wait
            wait_time = 0.0
            
            if self._tokens_second < tokens:
                wait_time = max(wait_time, (tokens - self._tokens_second) / self.config.requests_per_second)
            
            if self._tokens_minute < tokens:
                wait_time = max(wait_time, (tokens - self._tokens_minute) / (self.config.requests_per_minute / 60))
            
            if wait_time > 0:
                self._total_waits += 1
                logger.debug(
                    "rate_limit_wait",
                    service=self.service,
                    wait_seconds=round(wait_time, 2),
                )
                await asyncio.sleep(wait_time)
            
            # Consume tokens
            self._tokens_second -= tokens
            self._tokens_minute -= tokens
            self._total_requests += 1
            
            return wait_time
    
    def stats(self) -> dict:
        """Get rate limiter statistics."""
        return {
            "service": self.service,
            "total_requests": self._total_requests,
            "total_waits": self._total_waits,
            "tokens_available": {
                "second": round(self._tokens_second, 2),
                "minute": round(self._tokens_minute, 2),
            },
        }


# Global rate limiters (singleton per service)
_rate_limiters: dict = {}


def get_rate_limiter(service: str) -> RateLimiter:
    """Get or create a rate limiter for a service."""
    if service not in _rate_limiters:
        _rate_limiters[service] = RateLimiter(service)
    return _rate_limiters[service]


# ============================================
# CIRCUIT BREAKER
# ============================================

@dataclass
class CircuitState:
    """State of a circuit breaker."""
    failures: int = 0
    last_failure: float = 0.0
    state: str = "closed"  # closed, open, half-open
    
    
class CircuitBreaker:
    """
    Circuit breaker to prevent cascading failures.
    
    States:
    - closed: Normal operation
    - open: All calls fail immediately
    - half-open: Allow one test call
    """
    
    def __init__(
        self,
        service: str,
        failure_threshold: int = 5,
        reset_timeout: float = 60.0,
    ):
        self.service = service
        self.failure_threshold = failure_threshold
        self.reset_timeout = reset_timeout
        self._state = CircuitState()
        self._lock = asyncio.Lock()
    
    async def call(self, func: Callable, *args, **kwargs):
        """
        Execute function with circuit breaker protection.
        """
        async with self._lock:
            # Check if circuit should reset
            if self._state.state == "open":
                if time.time() - self._state.last_failure > self.reset_timeout:
                    self._state.state = "half-open"
                    logger.info("circuit_half_open", service=self.service)
                else:
                    raise CircuitOpenError(f"Circuit open for {self.service}")
        
        try:
            result = await func(*args, **kwargs)
            
            async with self._lock:
                if self._state.state == "half-open":
                    self._state.state = "closed"
                    self._state.failures = 0
                    logger.info("circuit_closed", service=self.service)
            
            return result
            
        except Exception as e:
            async with self._lock:
                self._state.failures += 1
                self._state.last_failure = time.time()
                
                if self._state.failures >= self.failure_threshold:
                    self._state.state = "open"
                    logger.error(
                        "circuit_opened",
                        service=self.service,
                        failures=self._state.failures,
                    )
            
            raise


class CircuitOpenError(Exception):
    """Raised when circuit breaker is open."""
    pass


# Global circuit breakers
_circuit_breakers: dict = {}


def get_circuit_breaker(service: str) -> CircuitBreaker:
    """Get or create a circuit breaker for a service."""
    if service not in _circuit_breakers:
        _circuit_breakers[service] = CircuitBreaker(service)
    return _circuit_breakers[service]
