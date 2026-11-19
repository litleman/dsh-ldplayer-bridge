#!/usr/bin/env python3
"""Minimal local health server for testing Via 7.4.1 GM_xmlhttpRequest + ADB reverse.

This is a diagnostic stub, NOT the production task queue / DSH Bridge.
Bind only to 127.0.0.1. Set the same token in the Via diagnostic userscript.
"""
from http.server import BaseHTTPRequestHandler, HTTPServer
import hmac
import json
import os
from datetime import datetime, timezone

HOST = "127.0.0.1"
PORT = 18765
TOKEN = os.environ.get("DSH_BRIDGE_TOKEN", "")

if len(TOKEN) < 32:
    raise SystemExit(
        "Set DSH_BRIDGE_TOKEN to a random secret of at least 32 characters. "
        "Example: set DSH_BRIDGE_TOKEN=<your-random-token>"
    )

class Handler(BaseHTTPRequestHandler):
    def _send(self, status, payload):
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def _authorized(self):
        supplied = self.headers.get("X-DSH-Token", "")
        return hmac.compare_digest(supplied, TOKEN)

    def do_GET(self):
        if self.path != "/v1/health":
            self._send(404, {"error": "not_found"})
            return
        if not self._authorized():
            self._send(401, {"error": "unauthorized"})
            return
        self._send(200, {
            "status": "ok",
            "protocol": "v1-probe",
            "server_time": datetime.now(timezone.utc).isoformat()
        })

    def log_message(self, fmt, *args):
        # Avoid logging headers/tokens.
        print("%s - %s" % (self.address_string(), fmt % args))

if __name__ == "__main__":
    print(f"DSH diagnostic probe listening on http://{HOST}:{PORT}")
    print("Only /v1/health is implemented; this is not the production Bridge.")
    HTTPServer((HOST, PORT), Handler).serve_forever()
