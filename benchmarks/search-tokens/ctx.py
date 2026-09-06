#!/usr/bin/env python3
"""Capture unmodified ctx search output and independently validate result identities."""
from concurrent.futures import ThreadPoolExecutor
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess

root=Path(os.environ.get('BENCHMARK_ROOT', '/tmp/glia-search-benchmark')).resolve()
expected_binary_hash = '90807a133453ed6a2a70b6fdfb70a1ce7da9b6d4eb2cf33248020c664d330d99'
assert hashlib.sha256((root / 'ctx-bin').read_bytes()).hexdigest() == expected_binary_hash, 'Use the pinned ctx 1.3.1 macOS arm64 release.'
manifest=json.loads((root/'corpus/manifest.json').read_text())
out=root/'results/ctx'
wrapper=Path(__file__).resolve().parent/'ctx-isolated.py'
labels={'semaphore rollback':'semaphore-rollback','重建投影':'cjk'}
queries=manifest['commonQueries']+manifest['supplementalQueries']
commands=[]

def run(args):
    command=['/usr/bin/python3',str(wrapper),*args]
    p=subprocess.run(command,capture_output=True)
    return {'command':command,'exitCode':p.returncode,'stdout':p.stdout,'stderr':p.stderr}

def search_job(job):
    mode,query=job
    args=['search',query,'--limit','20','--backend','lexical','--refresh','off']
    if mode.startswith('events'): args+=['--events']
    if mode.endswith('json'): args+=['--format','json']
    result=run(args)
    directory=out/mode; directory.mkdir(parents=True,exist_ok=True)
    base=directory/labels.get(query,query)
    Path(str(base)+'.stdout').write_bytes(result.pop('stdout'))
    Path(str(base)+'.stderr').write_bytes(result.pop('stderr'))
    return {'mode':mode,'query':query,'label':labels.get(query,query),'stdoutPath':str(base)+'.stdout',**result}


# Import only the explicitly generated source tree, then confirm all records were indexed.
out.mkdir(parents=True, exist_ok=True)
imported = run(['import', '--provider', 'claude', '--path', str(Path(manifest['claudeConfigDir']) / 'projects'), '--progress', 'none', '--format', 'json'])
(out / 'import.stdout').write_bytes(imported['stdout'])
(out / 'import.stderr').write_bytes(imported['stderr'])
assert imported['exitCode'] == 0, imported['stderr'].decode()
totals = json.loads(imported['stdout'])['totals']
assert totals['current_indexed_sessions'] == len(manifest['sessions'])
assert totals['current_indexed_documents'] == manifest['sourceRecords']
assert totals['current_rejected_records'] == 0

jobs=[(mode,query) for mode in ['events-json','events-text','sessions-json','sessions-text'] for query in queries]
with ThreadPoolExecutor(max_workers=4) as pool: commands=list(pool.map(search_job,jobs))
(out/'commands.json').write_text(json.dumps(commands,indent=2,ensure_ascii=False)+'\n')
assert all(x['exitCode']==0 for x in commands),commands

results={}
for row in commands:
    if row['mode'].endswith('json'):
        results[(row['mode'],row['query'])]=json.loads(Path(row['stdoutPath']).read_text())['results']
event_ids=sorted({hit['ctx_event_id'] for hits in results.values() for hit in hits})
evidence_dir=out/'evidence'; evidence_dir.mkdir(exist_ok=True)
def evidence_job(event_id):
    readouts={}
    for verb,args in [('locate',['locate','event',event_id,'--format','json']),('show',['show','event',event_id,'--window','0','--format','json'])]:
        result=run(args)
        (evidence_dir/(event_id+'.'+verb+'.json')).write_bytes(result['stdout'])
        assert result['exitCode']==0,result
        readouts[verb]=json.loads(result['stdout'])
    return event_id,readouts
with ThreadPoolExecutor(max_workers=4) as pool: evidence=dict(pool.map(evidence_job,event_ids))

native={}
for event_id,readout in evidence.items():
    loc=readout['locate']
    record_id=next(v['Utf8'] for v in loc['provider_event_id']['Composite'] if 'Utf8' in v)
    native[event_id]=(loc['provider_session_id'],record_id)

# Validate complete text or tool payload against the exact original record identified by the native UUID.
source_records={}
for session in manifest['sessions']:
    for line_index,line in enumerate(Path(session['sourceFile']).read_text().splitlines(),1):
        record=json.loads(line)
        source_records[(session['sessionId'],record['uuid'])]=(line_index,record)
validations=[]
for event_id,identity in native.items():
    line,record=source_records[identity]
    displayed=evidence[event_id]['show']['event']
    expected_blocks=record['message']['content']
    if isinstance(expected_blocks,str): expected_text=expected_blocks
    else: expected_text=''.join(block['text'] for block in expected_blocks if block.get('type')=='text')
    text_exact=displayed.get('text')==expected_text if expected_text else None
    validations.append({'ctxEventId':event_id,'sessionId':identity[0],'uuid':identity[1],'line':line,
        'timestampExact':displayed.get('occurred_at')==record.get('timestamp'),
        'sessionExact':displayed.get('provider_session_id')==identity[0],
        'fullMessageTextExact':text_exact,'completeToolPayloadExact':displayed.get('structured_content')==expected_blocks[0] if displayed.get('event_type') in ('tool_call','tool_output') else None,'sourceRecordLocated':True,'kind':displayed.get('event_type')})

accuracy=[]
for (mode,query),hits in results.items():
    expected_events={(x['sessionId'],x['uuid']) for x in manifest['groundTruth'][query]}
    got_events={native[x['ctx_event_id']] for x in hits}
    if mode.startswith('sessions'):
        expected={x[0] for x in expected_events}; got={x[0] for x in got_events}
    else: expected=expected_events; got=got_events
    matching=got&expected
    text_mode=mode.replace('-json','-text')
    text=(out/text_mode/(labels.get(query,query)+'.stdout')).read_text()
    text_ids=re.findall(r'^\s+Event\s+([0-9a-f]+)\s*$',text,re.M)
    text_matches=len(text_ids)==len(hits) and all(full['ctx_event_id'].startswith(short) for full,short in zip(hits,text_ids))
    accuracy.append({'mode':mode,'query':query,'label':labels.get(query,query),'expected':len(expected),'returned':len(hits),
        'matched':len(matching),'precision':len(matching)/len(got) if got else (1 if not expected else 0),
        'recall':len(matching)/len(expected) if expected else 1,'falsePositives':sorted(got-expected),'falseNegatives':sorted(expected-got),
        'eventHitsMatchGroundTruth':all(event in expected_events for event in got_events),'textMatchesJSONEventIDs':text_matches,
        'snippetsContainingAllLiteralTerms':sum(all(term.casefold() in hit['snippet'].casefold() for term in query.split()) for hit in hits)})
report={'product':'ctx','version':'1.3.1','releaseCommit':'d382b6502dbf5e85f4ffc274b88633b63496b8c6',
 'binarySHA256':hashlib.sha256((root/'ctx-bin').read_bytes()).hexdigest(),
 'manifestSHA256':hashlib.sha256((root/'corpus/manifest.json').read_bytes()).hexdigest(),
 'context':'search has no context flag; native query-focused snippets max 320 grapheme clusters; show uses --window 0 for validation',
 'accuracy':accuracy,'evidenceValidation':validations}
(out/'accuracy.json').write_text(json.dumps(report,indent=2,ensure_ascii=False)+'\n')
for row in accuracy: print(row['mode'],row['query'],row['returned'],row['precision'],row['recall'],row['textMatchesJSONEventIDs'])
print('Validated',len(validations),'unique events; all message texts exact:',all(v['fullMessageTextExact'] is not False for v in validations))
