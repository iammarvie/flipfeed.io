#!/usr/bin/env python3
"""Serve the static Flipfeed PWA locally."""
from http.server import ThreadingHTTPServer, SimpleHTTPRequestHandler


if __name__ == "__main__":
    print("Flipfeed is available at http://127.0.0.1:8000", flush=True)
    ThreadingHTTPServer(("127.0.0.1", 8000), SimpleHTTPRequestHandler).serve_forever()
