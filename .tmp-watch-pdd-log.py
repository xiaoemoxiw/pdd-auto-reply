import json
import os
import time
from pathlib import Path


def main():
  path = Path(os.path.expanduser('~/Library/Application Support/元尾巴 · 拼多多客服助手/logs/api-traffic-log.jsonl'))
  path.parent.mkdir(parents=True, exist_ok=True)
  with path.open('r', errors='ignore') as f:
    f.seek(0, os.SEEK_END)
    while True:
      line = f.readline()
      if not line:
        time.sleep(0.2)
        continue
      try:
        row = json.loads(line)
      except Exception:
        continue
      entry = row.get('entry') or {}
      method = str(entry.get('method') or '')
      url = str(entry.get('url') or '')
      full = str(entry.get('fullUrl') or '')
      if method.startswith('WS-'):
        continue
      if any(skip in url for skip in ['/xg/pfb/a2', '/xg/pfb/b', '/csp-report']):
        continue
      body = entry.get('requestBody')
      if isinstance(body, str):
        body_preview = body[:500].replace('\n', ' ')
      else:
        body_preview = json.dumps(body, ensure_ascii=False)[:500]
      print(f'TS={entry.get("timestamp")} METHOD={method} URL={url} FULL={full} BODY={body_preview}', flush=True)


if __name__ == '__main__':
  main()
