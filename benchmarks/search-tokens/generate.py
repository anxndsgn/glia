#!/usr/bin/env python3
"""Generate a deterministic, synthetic Claude Code corpus and source UUID ground truth."""
import argparse
import datetime as dt
import json
from pathlib import Path
import subprocess
import uuid

DEFAULT_ROOT = Path('/tmp/glia-search-benchmark')
COMMON = ['lease', 'migration', 'quartz', 'checkpoint', 'missingbenchmarkword']
SUPPLEMENTAL = ['semaphore rollback', '重建投影', 'lateboundary', 'toolneedle']


def generate(root: Path) -> dict:
    root = root.resolve()
    corpus = root / 'corpus'
    project = corpus / 'project'
    claude = corpus / 'claude'
    project.mkdir(parents=True, exist_ok=True)
    subprocess.run(['git', 'init', '-q', str(project)], check=True)
    source_dir = claude / 'projects' / str(project).replace('/', '-')
    source_dir.mkdir(parents=True, exist_ok=True)
    truth = {query: [] for query in COMMON + SUPPLEMENTAL}
    sessions = []
    for number in range(8):
        sid = str(uuid.uuid5(uuid.NAMESPACE_URL, f'https://glia.fyi/benchmark/session/{number}'))
        texts = [
            f'Investigate task {number + 1} in the synthetic service repository.',
            'I will inspect the relevant implementation and keep the source references.',
            'The lease lasts 37 seconds and is renewed after 12 seconds.' if number < 4 else 'The rendering queue is drained before shutdown.',
            'Renew the lease before the worker sleeps; preserve the owner identifier.' if number < 4 else 'The worker stores its owner identifier in a local record.',
            'The selected implementation has a bounded queue and deterministic ordering.',
            'The regression case verifies the identifier and ordering of returned records.',
            'Apply the migration in transaction 42 and retain the previous schema until commit.' if number < 4 else 'The output uses a stable order across repeated requests.',
            ('semaphore controls admission. ' + 'Ordinary diagnostic detail about bounded buffers and stable identifiers. ' * 18 + 'rollback restores the previous value after a failed transaction.') if number == 0 else 'The focused checks passed with deterministic fixtures.',
            'The quartz scheduler fires every 17 seconds and records one completion marker.' if number >= 4 else 'The next check confirms that a cancelled operation frees its resources.',
            '我们需要重建投影缓存，然后核对事件顺序和原始引用。' if number in (1, 5) else 'The original event reference remains available for further inspection.',
            'Persist the checkpoint at sequence 23 before acknowledging the update.' if number % 2 == 0 else 'The acknowledgement follows a durable write.',
            None,
            None,
            ('Additional synthetic background about table layouts and consistent ordering. ' * 150 + 'lateboundary is the required marker after ten thousand characters.') if number == 7 else 'The implementation is complete and the targeted checks passed.',
        ]
        records = []
        previous = None
        for index, text in enumerate(texts):
            event_uuid = str(uuid.uuid5(uuid.NAMESPACE_URL, f'https://glia.fyi/benchmark/session/{number}/event/{index}'))
            role = 'user' if index % 2 == 0 else 'assistant'
            tool_id = f'toolu_synthetic_{number}'
            if index == 11:
                role = 'assistant'
                content = [{'type': 'tool_use', 'id': tool_id, 'name': 'Bash', 'input': {'command': 'printf toolneedle', 'description': 'Read a synthetic diagnostic marker'}}]
                searchable = 'toolneedle'
                kind = 'toolcall'
            elif index == 12:
                role = 'user'
                content = [{'type': 'tool_result', 'tool_use_id': tool_id, 'content': 'toolneedle diagnostic complete; exit status 0'}]
                searchable = 'toolneedle'
                kind = 'toolresult'
            else:
                content = text if role == 'user' else [{'type': 'text', 'text': text}]
                searchable = text
                kind = 'message'
            timestamp = (dt.datetime(2026, 9, 1, tzinfo=dt.timezone.utc) + dt.timedelta(hours=number, minutes=index)).isoformat(timespec='milliseconds').replace('+00:00', 'Z')
            record = {'type': role, 'uuid': event_uuid, 'parentUuid': previous, 'sessionId': sid, 'cwd': str(project), 'timestamp': timestamp, 'isSidechain': False, 'message': {'role': role, 'content': content}}
            if role == 'assistant':
                record['message']['id'] = f'msg_{number}_{index}'
                record['message']['model'] = 'synthetic-model'
            records.append(record)
            for query in truth:
                if all(term.casefold() in searchable.casefold() for term in query.split()):
                    truth[query].append({'sessionId': sid, 'uuid': event_uuid, 'line': index + 1, 'kind': kind, 'sourceFile': str(source_dir / f'{sid}.jsonl')})
            previous = event_uuid
        source = source_dir / f'{sid}.jsonl'
        source.write_text(''.join(json.dumps(row, ensure_ascii=False, separators=(',', ':')) + '\n' for row in records))
        sessions.append({'sessionId': sid, 'sourceFile': str(source), 'sourceRecords': len(records)})
    manifest = {'schemaVersion': 1, 'synthetic': True, 'project': str(project), 'claudeConfigDir': str(claude), 'sourceRecords': 112, 'sessions': sessions, 'commonQueries': COMMON, 'supplementalQueries': SUPPLEMENTAL, 'groundTruth': truth, 'settings': {'limit': 20, 'perSession': 3, 'contexts': [0, 2]}, 'notes': ['Common queries are standalone single ASCII words, so substring and lexical matching select the same message evidence.', 'Supplemental probes intentionally test differing multi-term, CJK, tool-event, and 10,000-character indexing semantics; they are not pooled into common token averages.', 'All contents and identifiers are generated. No real user Sessions are read.']}
    (corpus / 'manifest.json').write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + '\n')
    return manifest


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--root', type=Path, default=DEFAULT_ROOT)
    args = parser.parse_args()
    manifest = generate(args.root)
    print(json.dumps({'manifest': str(args.root.resolve() / 'corpus/manifest.json'), 'sourceRecords': manifest['sourceRecords'], 'commonHits': {query: len(manifest['groundTruth'][query]) for query in COMMON}}, ensure_ascii=False))
