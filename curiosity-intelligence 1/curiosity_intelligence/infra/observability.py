"""
Observability Module

Provides:
- Structured logging with structlog
- Error tracking with Sentry
- Distributed tracing with OpenTelemetry
- Metrics collection
"""

import os
import sys
import time
import logging
import functools
from typing import Optional, Any, Callable
from contextlib import contextmanager, asynccontextmanager
from dataclasses import dataclass

import structlog
from structlog.typing import FilteringBoundLogger


# ============================================
# STRUCTURED LOGGING
# ============================================

def configure_logging(
    level: str = "INFO",
    json_output: bool = False,
    service_name: str = "curiosity-intelligence",
):
    """
    Configure structured logging with structlog.
    
    Args:
        level: Log level (DEBUG, INFO, WARNING, ERROR)
        json_output: Output JSON (for production) or human-readable
        service_name: Service name for log context
    """
    
    # Shared processors
    shared_processors = [
        structlog.contextvars.merge_contextvars,
        structlog.processors.add_log_level,
        structlog.processors.TimeStamper(fmt="iso"),
        structlog.processors.StackInfoRenderer(),
    ]
    
    if json_output:
        # Production: JSON output for log aggregation
        processors = shared_processors + [
            structlog.processors.format_exc_info,
            structlog.processors.JSONRenderer(),
        ]
    else:
        # Development: Human-readable output
        processors = shared_processors + [
            structlog.dev.ConsoleRenderer(colors=True),
        ]
    
    structlog.configure(
        processors=processors,
        wrapper_class=structlog.make_filtering_bound_logger(
            getattr(logging, level.upper(), logging.INFO)
        ),
        context_class=dict,
        logger_factory=structlog.PrintLoggerFactory(),
        cache_logger_on_first_use=True,
    )
    
    # Add default context
    structlog.contextvars.bind_contextvars(
        service=service_name,
        environment=os.environ.get("ENVIRONMENT", "development"),
    )


# Get logger instance
logger: FilteringBoundLogger = structlog.get_logger()


# ============================================
# SENTRY ERROR TRACKING
# ============================================

_sentry_initialized = False


def init_sentry(
    dsn: Optional[str] = None,
    environment: str = "development",
    release: Optional[str] = None,
    traces_sample_rate: float = 0.1,
):
    """
    Initialize Sentry for error tracking.
    
    Args:
        dsn: Sentry DSN (or SENTRY_DSN env var)
        environment: Environment name
        release: Release version
        traces_sample_rate: Percentage of transactions to trace (0.0-1.0)
    """
    global _sentry_initialized
    
    dsn = dsn or os.environ.get("SENTRY_DSN")
    if not dsn:
        logger.info("sentry_disabled", reason="No DSN provided")
        return
    
    try:
        import sentry_sdk
        from sentry_sdk.integrations.asyncio import AsyncioIntegration
        
        sentry_sdk.init(
            dsn=dsn,
            environment=environment,
            release=release,
            traces_sample_rate=traces_sample_rate,
            integrations=[
                AsyncioIntegration(),
            ],
            # Attach request data
            send_default_pii=False,
            # Performance monitoring
            enable_tracing=True,
        )
        
        _sentry_initialized = True
        logger.info("sentry_initialized", environment=environment)
        
    except ImportError:
        logger.warning("sentry_not_installed", hint="pip install sentry-sdk")
    except Exception as e:
        logger.error("sentry_init_failed", error=str(e))


def capture_exception(
    exception: Exception,
    context: Optional[dict] = None,
    level: str = "error",
):
    """
    Capture an exception to Sentry.
    
    Args:
        exception: The exception to capture
        context: Additional context to attach
        level: Severity level
    """
    if not _sentry_initialized:
        return
    
    try:
        import sentry_sdk
        
        with sentry_sdk.push_scope() as scope:
            if context:
                for key, value in context.items():
                    scope.set_extra(key, value)
            scope.level = level
            sentry_sdk.capture_exception(exception)
            
    except Exception as e:
        logger.error("sentry_capture_failed", error=str(e))


def capture_message(
    message: str,
    level: str = "info",
    context: Optional[dict] = None,
):
    """Capture a message to Sentry."""
    if not _sentry_initialized:
        return
    
    try:
        import sentry_sdk
        sentry_sdk.capture_message(message, level=level)
    except Exception:
        pass


# ============================================
# OPENTELEMETRY TRACING
# ============================================

_tracer = None


def init_tracing(
    service_name: str = "curiosity-intelligence",
    endpoint: Optional[str] = None,
):
    """
    Initialize OpenTelemetry tracing.
    
    Args:
        service_name: Name of the service
        endpoint: OTLP endpoint (or OTEL_EXPORTER_OTLP_ENDPOINT env var)
    """
    global _tracer
    
    endpoint = endpoint or os.environ.get("OTEL_EXPORTER_OTLP_ENDPOINT")
    
    try:
        from opentelemetry import trace
        from opentelemetry.sdk.trace import TracerProvider
        from opentelemetry.sdk.trace.export import BatchSpanProcessor
        from opentelemetry.sdk.resources import Resource
        
        # Create resource
        resource = Resource.create({"service.name": service_name})
        
        # Create tracer provider
        provider = TracerProvider(resource=resource)
        
        if endpoint:
            from opentelemetry.exporter.otlp.proto.grpc.trace_exporter import OTLPSpanExporter
            
            exporter = OTLPSpanExporter(endpoint=endpoint)
            provider.add_span_processor(BatchSpanProcessor(exporter))
            logger.info("otel_tracing_enabled", endpoint=endpoint)
        else:
            logger.info("otel_tracing_local", hint="No endpoint, traces not exported")
        
        trace.set_tracer_provider(provider)
        _tracer = trace.get_tracer(service_name)
        
    except ImportError:
        logger.warning("opentelemetry_not_installed", hint="pip install opentelemetry-api opentelemetry-sdk")
    except Exception as e:
        logger.error("otel_init_failed", error=str(e))


@contextmanager
def trace_span(
    name: str,
    attributes: Optional[dict] = None,
):
    """
    Create a trace span for a code block.
    
    Usage:
        with trace_span("process_questions", {"count": 100}):
            # do work
    """
    if _tracer is None:
        yield None
        return
    
    try:
        from opentelemetry import trace
        
        with _tracer.start_as_current_span(name) as span:
            if attributes:
                for key, value in attributes.items():
                    span.set_attribute(key, value)
            yield span
            
    except Exception:
        yield None


@asynccontextmanager
async def trace_span_async(
    name: str,
    attributes: Optional[dict] = None,
):
    """Async version of trace_span."""
    with trace_span(name, attributes) as span:
        yield span


def trace_function(name: Optional[str] = None):
    """
    Decorator to trace a function.
    
    Usage:
        @trace_function("embed_questions")
        async def embed(texts: list) -> list:
            ...
    """
    def decorator(func: Callable):
        span_name = name or func.__name__
        
        @functools.wraps(func)
        async def async_wrapper(*args, **kwargs):
            with trace_span(span_name):
                return await func(*args, **kwargs)
        
        @functools.wraps(func)
        def sync_wrapper(*args, **kwargs):
            with trace_span(span_name):
                return func(*args, **kwargs)
        
        if asyncio_iscoroutinefunction(func):
            return async_wrapper
        return sync_wrapper
    
    return decorator


def asyncio_iscoroutinefunction(func):
    """Check if function is async."""
    import asyncio
    return asyncio.iscoroutinefunction(func)


# ============================================
# METRICS
# ============================================

@dataclass
class Metric:
    """A simple metric value."""
    name: str
    value: float
    tags: dict
    timestamp: float


class MetricsCollector:
    """
    Simple in-memory metrics collector.
    
    For production, replace with Prometheus client or StatsD.
    """
    
    def __init__(self):
        self._counters: dict = {}
        self._gauges: dict = {}
        self._histograms: dict = {}
    
    def increment(self, name: str, value: float = 1.0, tags: Optional[dict] = None):
        """Increment a counter."""
        key = self._make_key(name, tags)
        self._counters[key] = self._counters.get(key, 0) + value
    
    def gauge(self, name: str, value: float, tags: Optional[dict] = None):
        """Set a gauge value."""
        key = self._make_key(name, tags)
        self._gauges[key] = value
    
    def histogram(self, name: str, value: float, tags: Optional[dict] = None):
        """Record a histogram value."""
        key = self._make_key(name, tags)
        if key not in self._histograms:
            self._histograms[key] = []
        self._histograms[key].append(value)
    
    def _make_key(self, name: str, tags: Optional[dict]) -> str:
        if not tags:
            return name
        tag_str = ",".join(f"{k}={v}" for k, v in sorted(tags.items()))
        return f"{name}[{tag_str}]"
    
    def get_all(self) -> dict:
        """Get all metrics."""
        return {
            "counters": dict(self._counters),
            "gauges": dict(self._gauges),
            "histograms": {k: self._summarize_histogram(v) for k, v in self._histograms.items()},
        }
    
    def _summarize_histogram(self, values: list) -> dict:
        if not values:
            return {}
        sorted_vals = sorted(values)
        return {
            "count": len(values),
            "min": sorted_vals[0],
            "max": sorted_vals[-1],
            "avg": sum(values) / len(values),
            "p50": sorted_vals[len(values) // 2],
            "p95": sorted_vals[int(len(values) * 0.95)] if len(values) >= 20 else sorted_vals[-1],
        }


# Global metrics instance
metrics = MetricsCollector()


# ============================================
# INITIALIZATION
# ============================================

def init_observability(
    service_name: str = "curiosity-intelligence",
    log_level: str = None,
    json_logs: bool = None,
    sentry_dsn: str = None,
    otel_endpoint: str = None,
):
    """
    Initialize all observability components.
    
    Reads from environment variables if not provided:
    - LOG_LEVEL: DEBUG, INFO, WARNING, ERROR
    - JSON_LOGS: true/false
    - SENTRY_DSN: Sentry DSN
    - OTEL_EXPORTER_OTLP_ENDPOINT: OpenTelemetry endpoint
    """
    
    # Logging
    configure_logging(
        level=log_level or os.environ.get("LOG_LEVEL", "INFO"),
        json_output=json_logs if json_logs is not None else os.environ.get("JSON_LOGS", "").lower() == "true",
        service_name=service_name,
    )
    
    # Sentry
    init_sentry(
        dsn=sentry_dsn,
        environment=os.environ.get("ENVIRONMENT", "development"),
    )
    
    # Tracing
    init_tracing(
        service_name=service_name,
        endpoint=otel_endpoint,
    )
    
    logger.info(
        "observability_initialized",
        service=service_name,
        sentry=_sentry_initialized,
        tracing=_tracer is not None,
    )
