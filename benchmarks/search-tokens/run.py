#!/usr/bin/env python3
"""Measure complete Glia stdout with pinned tokenizers and validate source evidence."""
import argparse
import copy
import csv
import hashlib
import io
import json
import os
from pathlib import Path
import subprocess
import tarfile

from generate import DEFAULT_ROOT, generate

BASELINE = 'd33155e532e9b2282f86de3fd11277ea62c950a8'
REPO = Path(__file__).resolve().parents[2]
LABELS = {'semaphore rollback': 'semaphore-rollback', '重建投影': 'cjk'}


def write_json(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2) + '\n')


def capture(command, environment, cwd, output):
    completed = subprocess.run(command, env=environment, cwd=cwd, capture_output=True)
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_bytes(completed.stdout)
    output.with_suffix('.stderr').write_bytes(completed.stderr)
    if completed.returncode:
        raise RuntimeError(f'{command} failed ({completed.returncode}): {completed.stderr.decode()}')
    return completed.stdout


def snapshot(root, revision):
    destination = root / 'glia-before'
    marker = destination / '.benchmark-revision'
    if marker.exists() and marker.read_text().strip() != revision:
        raise RuntimeError('Baseline directory contains another revision; use a fresh --root.')
    if not marker.exists():
        destination.mkdir(parents=True, exist_ok=True)
        archive = subprocess.check_output(['git', 'archive', revision], cwd=REPO)
        with tarfile.open(fileobj=io.BytesIO(archive)) as stream:
            stream.extractall(destination)
        marker.write_text(revision + '\n')
    for relative in ('node_modules', 'packages/cli/node_modules'):
        target = destination / relative
        if not target.exists():
            target.symlink_to(REPO / relative, target_is_directory=True)
    return destination


def expand_result(document):
    """Restore every inherited identity/locator/context field before equality checks."""
    result = copy.deepcopy(document['result'])
    if 'matches' in result:
        return result
    assert result.pop('layout') == 'grouped'
    matches = []
    for group in result.pop('groups'):
        def with_locator(item):
            value = copy.deepcopy(item)
            value['locator'].setdefault('sourceFile', group['sourceFile'])
            return value
        contexts = {item['seq']: with_locator(item) for item in group.get('context', [])}
        for item in group['matches']:
            match = {'sessionId': group['sessionId'], 'harnessId': group['harnessId']}
            if 'archiveState' in group:
                match['archiveState'] = group['archiveState']
            match.update(with_locator(item))
            if 'contextSeqs' in match:
                match['context'] = [copy.deepcopy(contexts[seq]) for seq in match.pop('contextSeqs')]
            matches.append(match)
    result['matches'] = matches
    return result


def accuracy(document, query, manifest):
    result = expand_result(document)
    matches = result.get('matches', [])
    expected = {entry['uuid'] for entry in manifest['groundTruth'][query]}
    actual = {item['locator']['sourceEventId'] for item in matches}
    correct = len(expected & actual)
    # Check physical source evidence as well as membership. This is a source line,
    # not a product's private event sequence or rank.
    native = {entry['uuid']: entry for entry in manifest['groundTruth'][query]}
    citation_valid = all(item['locator']['sourceCursor'].split(':')[1] == str(native[item['locator']['sourceEventId']]['line']) for item in matches if item['locator']['sourceEventId'] in native)
    terms = query.casefold().split()
    visible = sum(all(term in item.get('excerpt', '').casefold() for term in terms) for item in matches)
    return {'expected': len(expected), 'returned': len(actual), 'truePositives': correct, 'precision': correct / len(actual) if actual else (1.0 if not expected else 0.0), 'recall': correct / len(expected) if expected else 1.0, 'missing': sorted(expected - actual), 'unexpected': sorted(actual - expected), 'sourceLinesValid': citation_valid, 'allQueryTermsVisible': visible, 'matchCount': len(matches), 'totalMatches': result.get('totalMatches')}



def verify_evidence(repository, mode, commands, manifest, environment, results):
    sources = {}
    for session in manifest['sessions']:
        raw = Path(session['sourceFile']).read_bytes()
        for line in raw.decode().splitlines():
            record = json.loads(line)
            sources[record['uuid']] = record
    references = {}
    for command in commands:
        if command['mode'] != f'{mode}-json-c0':
            continue
        for match in json.loads(Path(command['stdoutPath']).read_bytes())['result']['matches']:
            references[(match['sessionId'], match['eventSeq'])] = match
    directory = results / 'evidence' / mode
    checked_sessions = {}
    checked_events = []
    for (session_id, sequence), match in references.items():
        native = sources[match['locator']['sourceEventId']]
        if session_id not in checked_sessions:
            raw = capture(['bun', str(repository / 'packages/cli/src/cli.ts'), 'show', session_id, '--json'], environment, manifest['project'], directory / f'{session_id}.show.stdout')
            session = json.loads(raw)['result']['session']
            source_session = next(item for item in manifest['sessions'] if item['sessionId'] == session['sourceSessionId'])
            source_bytes = Path(source_session['sourceFile']).read_bytes()
            artifact = next(item for item in session['artifacts'] if item['path'] == 'source/transcript.jsonl')
            checked_sessions[session_id] = {'sourceSessionId': session['sourceSessionId'], 'originalBundleBytesVerified': artifact['sha256'] == hashlib.sha256(source_bytes).hexdigest() and artifact['size'] == len(source_bytes)}
        raw = capture(['bun', str(repository / 'packages/cli/src/cli.ts'), 'view', session_id, '--seq', str(sequence), '--json'], environment, manifest['project'], directory / f'{session_id}-{sequence}.view.stdout')
        event = json.loads(raw)['result']['event']
        content = native['message']['content']
        expected_text = content if isinstance(content, str) else '\n'.join(block.get('text', block.get('content', '') if block['type'] == 'tool_result' else '') for block in content if block.get('text') or (block['type'] == 'tool_result' and isinstance(block.get('content'), str)))
        checked_events.append({'sessionId': session_id, 'eventSeq': sequence, 'uuid': native['uuid'], 'fullTextExact': event.get('text', '') == expected_text, 'locatorExact': event['locator'] == match['locator'], 'timestampExact': event['timestamp'] == native['timestamp'], 'sourceSessionExact': checked_sessions[session_id]['sourceSessionId'] == native['sessionId']})
    evidence = {'sessions': checked_sessions, 'events': checked_events}
    write_json(results / f'{mode}-evidence.json', evidence)
    assert all(item['originalBundleBytesVerified'] for item in checked_sessions.values())
    assert all(all(item[key] for key in ('fullTextExact', 'locatorExact', 'timestampExact', 'sourceSessionExact')) for item in checked_events)


def run_glia(root, revision, before_only=False):
    manifest = generate(root)
    baseline = snapshot(root, revision)
    home = root / 'glia-home'
    home.mkdir(exist_ok=True)
    environment = {key: value for key, value in os.environ.items() if key in ('PATH', 'TMPDIR', 'SYSTEMROOT')}
    environment.update({'HOME': str(home), 'GLIA_HOME': str(root / 'glia-state'), 'CLAUDE_CONFIG_DIR': manifest['claudeConfigDir'], 'CODEX_HOME': str(root / 'empty-codex'), 'NO_COLOR': '1', 'TZ': 'UTC', 'GIT_CONFIG_NOSYSTEM': '1', 'GIT_CONFIG_GLOBAL': '/dev/null', 'GIT_AUTHOR_NAME': 'Synthetic Benchmark', 'GIT_AUTHOR_EMAIL': 'benchmark@example.invalid', 'GIT_COMMITTER_NAME': 'Synthetic Benchmark', 'GIT_COMMITTER_EMAIL': 'benchmark@example.invalid'})
    results = root / 'results' / 'glia'
    capture(['bun', str(baseline / 'packages/cli/src/cli.ts'), 'import', '--harness', 'claude-code', '--no-input', '--json'], environment, manifest['project'], results / 'import.stdout')
    configurations = [('before-json', baseline, ['--json']), ('before-human', baseline, [])]
    if not before_only:
        configurations += [('after-json', REPO, ['--json']), ('after-human', REPO, []), ('after-compact', REPO, ['--json', '--compact'])]
    commands, quality = [], []
    for mode, repository, output_args in configurations:
        for context in manifest['settings']['contexts']:
            for query in manifest['commonQueries'] + manifest['supplementalQueries']:
                label = LABELS.get(query, query)
                output = results / f'{mode}-c{context}' / f'{label}.stdout'
                command = ['bun', str(repository / 'packages/cli/src/cli.ts'), 'search', query, '--limit', '20', '--per-session', '3', '-C', str(context), *output_args]
                raw = capture(command, environment, manifest['project'], output)
                commands.append({'query': query, 'label': label, 'mode': f'{mode}-c{context}', 'stdoutPath': str(output), 'command': command, 'exitCode': 0})
                if '--json' in output_args:
                    document = json.loads(raw)
                    quality.append({'query': query, 'mode': f'{mode}-c{context}', **accuracy(document, query, manifest)})
    write_json(results / 'commands.json', commands)
    write_json(results / 'accuracy.json', quality)
    verify_evidence(baseline, 'before', commands, manifest, environment, results)
    if not before_only:
        verify_evidence(REPO, 'after', commands, manifest, environment, results)
    comparisons = []
    if not before_only:
        for context in manifest['settings']['contexts']:
            for query in manifest['commonQueries'] + manifest['supplementalQueries']:
                label = LABELS.get(query, query)
                documents = {mode: json.loads((results / f'{mode}-c{context}' / f'{label}.stdout').read_bytes()) for mode in ('before-json', 'after-json', 'after-compact')}
                before = expand_result(documents['before-json'])
                after = expand_result(documents['after-json'])
                restored = expand_result(documents['after-compact'])
                # Layout is the only intended result-shape change. Once expanded,
                # Session/event identities, locators, ordering and all text must match.
                flat_equal = before == after
                compact_equal = after == restored
                flat_bytes = (results / f'after-json-c{context}' / f'{label}.stdout').stat().st_size
                compact_bytes = (results / f'after-compact-c{context}' / f'{label}.stdout').stat().st_size
                comparisons.append({'query': query, 'context': context, 'compactLayout': documents['after-compact']['result'].get('layout', 'flat'), 'flatStdoutBytes': flat_bytes, 'compactStdoutBytes': compact_bytes, 'oldAndNewFlatResultsEqual': flat_equal, 'compactRestoresFlatResult': compact_equal})
        write_json(results / 'equivalence.json', comparisons)
        assert {item['compactLayout'] for item in comparisons} == {'flat', 'grouped'}, 'The corpus must exercise both compact layouts.'
        assert all(item['compactStdoutBytes'] <= item['flatStdoutBytes'] for item in comparisons)
        if not all(item['oldAndNewFlatResultsEqual'] and item['compactRestoresFlatResult'] for item in comparisons):
            raise RuntimeError(f'Output equivalence failed; inspect {results / "equivalence.json"}')
    return quality


def summarize(root):
    os.environ['TIKTOKEN_CACHE_DIR'] = str(root / 'tiktoken-cache')
    import tiktoken
    if tiktoken.__version__ != '0.12.0':
        raise RuntimeError('Install tiktoken==0.12.0 for reproducible counts.')
    encodings = {name: tiktoken.get_encoding(name) for name in ('o200k_base', 'cl100k_base')}
    manifest = json.loads((root / 'corpus/manifest.json').read_text())
    rows = []
    for command_file in sorted((root / 'results').glob('*/commands.json')):
        product = command_file.parent.name
        commands = json.loads(command_file.read_text())
        if isinstance(commands, dict):
            commands = commands.get('commands', commands.get('runs', []))
        for command in commands:
            if 'query' not in command or not command.get('stdoutPath'):
                continue
            path = Path(command['stdoutPath'])
            raw = path.read_bytes()
            text = raw.decode('utf-8')
            rows.append({'product': product, 'mode': command['mode'], 'query': command['query'], 'suite': 'common' if command['query'] in manifest['commonQueries'] else 'supplemental', 'bytes': len(raw), **{name: len(encoding.encode(text, disallowed_special=())) for name, encoding in encodings.items()}, 'stdoutPath': str(path)})
    aggregates = []
    for product, mode in sorted({(row['product'], row['mode']) for row in rows}):
        selected = [row for row in rows if row['product'] == product and row['mode'] == mode and row['suite'] == 'common']
        if selected:
            totals = {key: sum(row[key] for row in selected) for key in ('bytes', *encodings)}
            aggregates.append({'product': product, 'mode': mode, 'queries': len(selected), **totals, 'meanO200k': totals['o200k_base'] / len(selected), 'meanCl100k': totals['cl100k_base'] / len(selected)})
    summary = {'tokenizer': 'tiktoken==0.12.0', 'encodings': list(encodings), 'measurement': 'Complete UTF-8 stdout, including JSON envelopes, formatting, and trailing newlines; stderr and tool transport wrappers excluded.', 'commonQueries': manifest['commonQueries'], 'rows': rows, 'commonAggregates': aggregates}
    write_json(root / 'results/token-summary.json', summary)
    print(json.dumps(aggregates, indent=2))
    return summary


def export_measurements(root, summary, destination):
    manifest = json.loads((root / 'corpus/manifest.json').read_text())
    results = root / 'results'
    query_file = destination.with_name(destination.stem + '-queries.csv')
    query_file.parent.mkdir(parents=True, exist_ok=True)
    with query_file.open('w', newline='') as stream:
        columns = ['product', 'mode', 'query', 'suite', 'bytes', 'o200k_base', 'cl100k_base', 'stdoutSHA256']
        writer = csv.DictWriter(stream, fieldnames=columns, lineterminator='\n')
        writer.writeheader()
        for row in summary['rows']:
            writer.writerow({**{key: value for key, value in row.items() if key != 'stdoutPath'}, 'stdoutSHA256': hashlib.sha256(Path(row['stdoutPath']).read_bytes()).hexdigest()})
    export = {
        'observedDate': '2026-09-06',
        'platform': 'macOS arm64',
        'provenance': {
            'gliaBeforeCommit': (root / 'glia-before/.benchmark-revision').read_text().strip(),
            'gliaAfter': 'current checkout with search --compact',
            'gliaSearchSourceSHA256': hashlib.sha256((REPO / 'packages/cli/src/session/commands/search.ts').read_bytes()).hexdigest(),
            'ctxVersion': '1.3.1',
            'ctxCommit': 'd382b6502dbf5e85f4ffc274b88633b63496b8c6',
            'ctxBinarySHA256': '90807a133453ed6a2a70b6fdfb70a1ce7da9b6d4eb2cf33248020c664d330d99',
            'obeliskCommit': '69d9e21a90e55f310376d8f49929b1c16f5a1f0c',
            'obeliskCliVersion': '0.2.6-rc.0',
        },
        'corpus': {'synthetic': True, 'sessions': len(manifest['sessions']), 'sourceRecords': manifest['sourceRecords'], 'commonQueries': manifest['commonQueries'], 'supplementalQueries': manifest['supplementalQueries'], 'expectedSourceMatches': {query: len(matches) for query, matches in manifest['groundTruth'].items()}},
        'tokenizer': summary['tokenizer'],
        'measurement': summary['measurement'],
        'commonAggregates': summary['commonAggregates'],
        'perQueryFile': query_file.name,
    }
    equality_file = results / 'glia/equivalence.json'
    if equality_file.exists():
        export['gliaEquivalence'] = json.loads(equality_file.read_text())
    quality = json.loads((results / 'glia/accuracy.json').read_text())
    export['gliaAccuracy'] = [row for row in quality if row['mode'] in ('before-json-c0', 'after-compact-c0')]
    ctx_file = results / 'ctx/accuracy.json'
    if ctx_file.exists():
        ctx = json.loads(ctx_file.read_text())
        export['ctxAccuracy'] = ctx['accuracy']
        validation = ctx['evidenceValidation']
        export['ctxEvidenceValidation'] = {'eventsChecked': len(validation), 'allTimestampsExact': all(row['timestampExact'] for row in validation), 'allSessionsExact': all(row['sessionExact'] for row in validation), 'allMessageTextExact': all(row['fullMessageTextExact'] is not False for row in validation), 'allToolPayloadsExact': all(row['completeToolPayloadExact'] is not False for row in validation)}
    obelisk_file = results / 'obelisk/quality.json'
    if obelisk_file.exists():
        export['obeliskAccuracy'] = [{key: value for key, value in row.items() if key != 'missingIdentities'} for row in json.loads(obelisk_file.read_text())]
    export['gliaEvidenceValidation'] = {}
    for mode in ('before', 'after'):
        path = results / f'glia/{mode}-evidence.json'
        if path.exists():
            data = json.loads(path.read_text())
            export['gliaEvidenceValidation'][mode] = {'sessionsChecked': len(data['sessions']), 'eventsChecked': len(data['events']), 'allOriginalBundleBytesVerified': all(row['originalBundleBytesVerified'] for row in data['sessions'].values()), 'allEventTextLocatorsTimestampsAndSessionsExact': all(all(row[key] for key in ('fullTextExact', 'locatorExact', 'timestampExact', 'sourceSessionExact')) for row in data['events'])}
    write_json(destination, export)


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--root', type=Path, default=DEFAULT_ROOT)
    parser.add_argument('--baseline', default=BASELINE)
    parser.add_argument('--before-only', action='store_true')
    parser.add_argument('--summarize-only', action='store_true')
    parser.add_argument('--export', type=Path, help='write a portable measured-results snapshot (no local stdout paths)')
    args = parser.parse_args()
    root = args.root.resolve()
    if not args.summarize_only:
        run_glia(root, args.baseline, args.before_only)
    summary = summarize(root)
    if args.export:
        export_measurements(root, summary, args.export)
