"""Read the public workbook (including drawings) into private practice sources.

Requirements: Pillow, tesseract with chi_tra + eng + vie. No OpenAI key here.
Only the dedicated HOMEWORK_WORKER_SECRET is sent to the homework endpoint.
Use --inspect to examine counts without contacting the app.
"""
import argparse
import base64
import csv
import hashlib
import io
import json
import os
import posixpath
import subprocess
import tempfile
import time
import urllib.error
import urllib.request
import zipfile
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path
from xml.etree import ElementTree as ET

from PIL import Image, ImageOps

SHEET = '113kPo9oyBvzYraQultqDYh_og7A9xj9GQh_wS_gq2TQ'
URL = f'https://docs.google.com/spreadsheets/d/{SHEET}/export?format=xlsx'
M = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main'
R = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships'
D = 'http://schemas.openxmlformats.org/drawingml/2006/spreadsheetDrawing'
A = 'http://schemas.openxmlformats.org/drawingml/2006/main'


def relationships(z, path):
    folder, name = posixpath.split(path)
    relpath = posixpath.join(folder, '_rels', name + '.rels')
    if relpath not in z.namelist():
        return {}
    return {r.attrib['Id']: posixpath.normpath(posixpath.join(folder, r.attrib['Target'].lstrip('/'))) if not r.attrib['Target'].startswith('/') else r.attrib['Target'].lstrip('/')
            for r in ET.fromstring(z.read(relpath)) if r.attrib.get('TargetMode') != 'External'}


def workbook(path):
    rows, images = [], {}
    with zipfile.ZipFile(path) as z:
        if sum(i.file_size for i in z.infolist()) > 2_000_000_000:
            raise ValueError('Workbook expands beyond 2 GB')
        strings = []
        if 'xl/sharedStrings.xml' in z.namelist():
            strings = [''.join(si.itertext()) for si in ET.fromstring(z.read('xl/sharedStrings.xml'))]
        rels = relationships(z, 'xl/workbook.xml')
        for sheet in ET.fromstring(z.read('xl/workbook.xml')).find(f'{{{M}}}sheets'):
            if sheet.attrib.get('state', 'visible') != 'visible':
                continue
            name, sid = sheet.attrib['name'], sheet.attrib['sheetId']
            path = rels[sheet.attrib[f'{{{R}}}id']]
            xml = ET.fromstring(z.read(path))
            for row in xml.findall(f'.//{{{M}}}sheetData/{{{M}}}row'):
                cells = []
                for c in row.findall(f'{{{M}}}c'):
                    value = c.findtext(f'{{{M}}}v', '')
                    if c.attrib.get('t') == 's' and value:
                        value = strings[int(value)]
                    elif c.attrib.get('t') == 'inlineStr':
                        value = ''.join(c.find(f'{{{M}}}is').itertext())
                    if value.strip():
                        cells.append(c.attrib['r'] + ': ' + value.strip())
                if cells:
                    content = '\n'.join(cells)
                    # Keep long rows in numbered chunks instead of silently losing text.
                    for chunk in range(0, len(content), 11000):
                        rows.append({'key': f'{sid}:{row.attrib["r"]}:{chunk//11000}', 'label': f'{name} · row {row.attrib["r"]}', 'content': content[chunk:chunk+11000]})
            sheetrels = relationships(z, path)
            for drawing in xml.findall(f'{{{M}}}drawing'):
                drawingpath = sheetrels[drawing.attrib[f'{{{R}}}id']]
                drawingrels = relationships(z, drawingpath)
                for anchor in ET.fromstring(z.read(drawingpath)):
                    row = anchor.findtext(f'{{{D}}}from/{{{D}}}row', '0')
                    for blip in anchor.findall(f'.//{{{A}}}blip'):
                        target = drawingrels.get(blip.attrib.get(f'{{{R}}}embed'))
                        if target and target in z.namelist():
                            digest = hashlib.sha256(z.read(target)).hexdigest()
                            images.setdefault(digest, {'hash': digest, 'path': target, 'label': f'{name} · image near row {int(row)+1}'})
    return rows, list(images.values())


def request(action, body):
    url = os.environ['HOMEWORK_URL'] + '?action=' + action
    payload = json.dumps(body, ensure_ascii=False).encode()
    headers = {'Content-Type': 'application/json', 'x-worker-secret': os.environ['HOMEWORK_WORKER_SECRET']}
    for attempt in range(3):
        try:
            with urllib.request.urlopen(urllib.request.Request(url, payload, headers), timeout=125) as r:
                return json.load(r)
        except urllib.error.HTTPError as e:
            if e.code < 500 or attempt == 2:
                # Server errors are deliberately user-safe, never echo credentials.
                detail = json.loads(e.read()).get('error', 'Import request failed')
                raise RuntimeError(f'{action}: {e.code}: {detail}') from None
        except (TimeoutError, urllib.error.URLError):
            if attempt == 2:
                raise RuntimeError(f'{action}: connection failed') from None
        time.sleep(2 * (attempt+1))


def resized(path, entry):
    with zipfile.ZipFile(path) as z, Image.open(io.BytesIO(z.read(entry['path']))) as original:
        image = ImageOps.exif_transpose(original).convert('RGB')
        image.thumbnail((2400, 2400))
        if max(image.size) < 1200:
            image = image.resize((image.width*2, image.height*2))
        stream = io.BytesIO()
        image.save(stream, format='PNG')
        return stream.getvalue()


def recognize(path, entry):
    env = dict(os.environ, OMP_THREAD_LIMIT='1')
    with tempfile.TemporaryDirectory(prefix='margin-ocr-') as tmp:
        image = Path(tmp)/'image.png'
        image.write_bytes(resized(path, entry))
        result = subprocess.run([os.environ.get('TESSERACT_BIN', 'tesseract'), str(image), 'stdout', '-l', 'chi_tra+eng+vie', '--psm', '11', 'tsv'], capture_output=True, timeout=90, env=env, check=True)
    lines, confidence = {}, []
    for item in csv.DictReader(io.StringIO(result.stdout.decode('utf-8')), delimiter='\t', quoting=csv.QUOTE_NONE):
        word = item.get('text', '').strip()
        if not word:
            continue
        index = tuple(item[k] for k in ['page_num','block_num','par_num','line_num'])
        lines.setdefault(index, []).append(word)
        confidence.append(float(item['conf']))
    score = round(sum(confidence)/len(confidence)) if confidence else 0
    content = '\n'.join(' '.join(line) for line in lines.values())
    # Tesseract separates each Han character with spaces. Join those while retaining gloss words.
    import re
    content = re.sub(r'(?<=[\u3400-\u9fff]) +(?=[\u3400-\u9fff])', '', content)
    return {'hash': entry['hash'], 'label': entry['label'], 'content': f'[OCR transcription; confidence {score}/100. May contain errors; exclude uncertain phrases.]\n{content}'[:16000]}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--file')
    parser.add_argument('--inspect', action='store_true')
    parser.add_argument('--workers', type=int, default=4)
    parser.add_argument('--vision-limit', type=int, default=3)
    args = parser.parse_args()
    with tempfile.TemporaryDirectory(prefix='margin-sheet-') as tmp:
        path = args.file or str(Path(tmp)/'source.xlsx')
        if not args.file:
            print('Downloading public workbook…', flush=True)
            with urllib.request.urlopen(URL, timeout=240) as response, open(path, 'wb') as out:
                count = 0
                while chunk := response.read(1024*1024):
                    count += len(chunk)
                    if count > 1_000_000_000:
                        raise ValueError('Workbook exceeds 1 GB')
                    out.write(chunk)
        rows, images = workbook(path)
        print(f'Parsed {len(rows)} text rows and {len(images)} distinct embedded images.', flush=True)
        if args.inspect:
            return
        digest = hashlib.sha256()
        with open(path, 'rb') as f:
            while chunk := f.read(1024*1024):
                digest.update(chunk)
        previous = request('import-status', {})
        cached = {s['source_key']: s['content_hash'] for s in previous['sources']}
        request('import-begin', {'hash':digest.hexdigest(),'image_total':len(images)})
        changed = [r for r in rows if cached.get('sheet:'+r['key']) != hashlib.sha256(r['content'].encode()).hexdigest()]
        for i in range(0,len(changed),75):
            request('import-text', {'rows':changed[i:i+75]})
        pending = [i for i in images if 'image:'+i['hash'] not in cached]
        processed = len(images)-len(pending)
        keys = ['sheet:'+r['key'] for r in rows] + ['image:'+i['hash'] for i in images]
        def finish(complete):
            request('import-finish', {'keys':keys,'complete':complete,'image_processed':processed})
        finish(False)
        for entry in pending[:args.vision_limit]:
            try:
                encoded = base64.b64encode(resized(path,entry)).decode()
                request('import-image', {'hash':entry['hash'],'label':entry['label'],'data':'data:image/png;base64,'+encoded})
                processed += 1
                cached['image:'+entry['hash']] = entry['hash']
            except RuntimeError as e:
                print(f'Vision unavailable; continuing with OCR: {e}', flush=True)
                break
        pending = [i for i in pending if 'image:'+i['hash'] not in cached]
        failures, batch = 0, []
        with ThreadPoolExecutor(max_workers=args.workers) as pool:
            jobs = {pool.submit(recognize,path,entry): entry for entry in pending}
            for job in as_completed(jobs):
                try:
                    batch.append(job.result())
                except Exception:
                    failures += 1
                    print('One image could not be read; it will be retried on the next sync.', flush=True)
                if len(batch)>=20:
                    request('import-ocr', {'rows':batch}); processed += len(batch); batch=[]; finish(False)
                    print(f'Images read: {processed}/{len(images)}', flush=True)
        if batch:
            request('import-ocr', {'rows':batch}); processed += len(batch)
        finish(failures==0)
        print(f'Sync complete: {len(rows)} text rows, {processed}/{len(images)} images; {failures} pending retries.', flush=True)
        if failures:
            raise SystemExit(1)


if __name__ == '__main__':
    main()
