# Helyi fejlesztői szerver gyorsítótár nélkül (a módosított JS-modulok azonnal frissülnek).
# Használat: python3 tools/serve.py [port]   → http://localhost:8824
import http.server, os, sys
os.chdir(os.path.join(os.path.dirname(os.path.abspath(__file__)), '..'))
class H(http.server.SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header('Cache-Control', 'no-store')
        super().end_headers()
port = int(sys.argv[1]) if len(sys.argv) > 1 else 8824
http.server.ThreadingHTTPServer(('127.0.0.1', port), H).serve_forever()
