import http.server
import urllib.request
import urllib.parse
import os

PORT = 8080
DIRECTORY = os.path.dirname(os.path.abspath(__file__))

class MangaHandler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=DIRECTORY, **kwargs)

    def do_GET(self):
        if self.path.startswith('/api/proxy?url='):
            target_url = urllib.parse.unquote(self.path.split('/api/proxy?url=', 1)[1])
            try:
                parsed = urllib.parse.urlparse(target_url)
                origin = f"{parsed.scheme}://{parsed.netloc}/"
                
                req = urllib.request.Request(target_url, headers={
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
                    'Referer': origin
                })
                with urllib.request.urlopen(req, timeout=15) as resp:
                    self.send_response(resp.status)
                    self.send_header('Access-Control-Allow-Origin', '*')
                    for header, val in resp.getheaders():
                        if header.lower() in ['content-type', 'content-length', 'cache-control']:
                            self.send_header(header, val)
                    self.end_headers()
                    self.wfile.write(resp.read())
            except Exception as e:
                self.send_response(500)
                self.send_header('Access-Control-Allow-Origin', '*')
                self.end_headers()
                self.wfile.write(f"Proxy Error: {e}".encode())
            return
            
        super().do_GET()

if __name__ == '__main__':
    with http.server.HTTPServer(("", PORT), MangaHandler) as httpd:
        print(f"Clean Manga Reader running at http://localhost:{PORT}/")
        httpd.serve_forever()
