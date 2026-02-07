"""
Gunicorn Configuration for Production

Run with: gunicorn curiosity_intelligence.api.main:app -c gunicorn.conf.py
"""

import os
import multiprocessing

# =============================================================================
# SERVER SOCKET
# =============================================================================

bind = f"{os.environ.get('HOST', '0.0.0.0')}:{os.environ.get('PORT', '8000')}"
backlog = 2048

# =============================================================================
# WORKER PROCESSES
# =============================================================================

# Number of worker processes
# Recommendation: (2 * CPU cores) + 1
workers = int(os.environ.get('WORKERS', multiprocessing.cpu_count() * 2 + 1))

# Worker class - use uvicorn for async support
worker_class = 'uvicorn.workers.UvicornWorker'

# Maximum requests per worker before restart (prevents memory leaks)
max_requests = 1000
max_requests_jitter = 50

# Worker timeout
timeout = 120
graceful_timeout = 30
keepalive = 5

# =============================================================================
# SECURITY
# =============================================================================

# Limit request sizes
limit_request_line = 4094
limit_request_fields = 100
limit_request_field_size = 8190

# =============================================================================
# LOGGING
# =============================================================================

# Log level
loglevel = os.environ.get('LOG_LEVEL', 'info').lower()

# Access log - use stdout for container logging
accesslog = '-'
access_log_format = '%(h)s %(l)s %(u)s %(t)s "%(r)s" %(s)s %(b)s "%(f)s" "%(a)s" %(D)s'

# Error log - use stderr for container logging
errorlog = '-'

# Capture output from application
capture_output = True

# =============================================================================
# PROCESS NAMING
# =============================================================================

proc_name = 'curiosity-intelligence-api'

# =============================================================================
# SERVER HOOKS
# =============================================================================

def on_starting(server):
    """Called just before the master process is initialized."""
    pass

def on_reload(server):
    """Called when receiving SIGHUP."""
    pass

def worker_int(worker):
    """Called when a worker receives SIGINT or SIGQUIT."""
    pass

def pre_fork(server, worker):
    """Called just before a worker is forked."""
    pass

def post_fork(server, worker):
    """Called just after a worker is forked."""
    pass

def post_worker_init(worker):
    """Called just after a worker has initialized."""
    pass

def worker_abort(worker):
    """Called when a worker times out."""
    pass

def pre_exec(server):
    """Called just before a new master process is forked."""
    pass

def when_ready(server):
    """Called just after the server is started."""
    pass

def child_exit(server, worker):
    """Called when a worker process exits."""
    pass

def worker_exit(server, worker):
    """Called just after a worker exits."""
    pass

def nworkers_changed(server, new_value, old_value):
    """Called when the number of workers changes."""
    pass
