#!/usr/bin/env python3
"""Run native and documented compact Obelisk searches against the synthetic corpus."""
import json, os, pathlib, subprocess, time
base = pathlib.Path(os.environ.get('BENCHMARK_ROOT', '/tmp/glia-search-benchmark')).resolve()
assert subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=base / 'obelisk', text=True).strip() == '69d9e21a90e55f310376d8f49929b1c16f5a1f0c', 'Check out the pinned Obelisk commit.'
manifest = json.loads((base / 'corpus/manifest.json').read_text())
out = base / 'results/obelisk'
out.mkdir(parents=True, exist_ok=True)
home = base / 'obelisk-benchmark-home'
settings = home / '.obelisk/settings.json'
settings.parent.mkdir(parents=True, exist_ok=True)
roots = {p: str(base / ('obelisk-empty-' + p)) for p in ('claude','codex','deepseek','kimi','pi')}
roots['claude'] = manifest['claudeConfigDir']
for root in roots.values(): pathlib.Path(root).mkdir(parents=True, exist_ok=True)
settings.write_text(json.dumps({'providerRoots': roots}))
env = dict(os.environ, HOME=str(home))
cli = str(base / 'obelisk/packages/cli/src/obelisk.ts')
command_prefix = ['node','--no-warnings=ExperimentalWarning',cli]
commands=[]
def run(args, target):
    start = time.perf_counter()
    result = subprocess.run([*command_prefix,*args], env=env, cwd=base, capture_output=True)
    target.write_bytes(result.stdout)
    target.with_suffix('.stderr').write_bytes(result.stderr)
    commands.append({'argv':[*command_prefix,*args], 'cwd':str(base),'environmentOverrides':{'HOME':str(home)},'stdout':str(target),'exitCode':result.returncode,'elapsedSeconds':round(time.perf_counter()-start,6)})
    if result.returncode: raise RuntimeError(result.stdout.decode()+result.stderr.decode())
    return json.loads(result.stdout)
run(['--build'],out / 'build.stdout')
quality=[]
for mode in ('default','compact','context2'):
    (out / mode).mkdir(exist_ok=True)
    (out / 'queries' / mode).mkdir(parents=True, exist_ok=True)
    for query in manifest['commonQueries'] + manifest['supplementalQueries']:
        label='cjk' if query=='重建投影' else query.replace(' ','-')
        target=out / mode / (label+'.stdout')
        script=None
        if mode=='default': args=['--search',query]
        else:
            script='const hits = search('+json.dumps(query,ensure_ascii=False)+', {limit:20});\n'
            if mode=='compact':
                script+='return hits.map(h => ({session_id:h.session.id, session_title:h.session.title, uuid:h.message.uuid, snippet:h.message.text?.slice(0,240)}));\n'
            else:
                script+='''return hits.map(h => {
  const fields = "uuid,text,content_type,is_meta,role,timestamp,model,COALESCE(visibility,'visible') AS visibility,COALESCE(source,'claude') AS source";
  const filter = "session_id=? AND uuid!=? AND COALESCE(is_meta,0)=0 AND COALESCE(visibility,'visible')='visible'";
  const before = sql(`SELECT ${fields} FROM messages WHERE ${filter} AND timestamp<? ORDER BY timestamp DESC LIMIT 2`, h.session.id,h.message.uuid,h.message.timestamp).reverse();
  const after = sql(`SELECT ${fields} FROM messages WHERE ${filter} AND timestamp>? ORDER BY timestamp LIMIT 2`, h.session.id,h.message.uuid,h.message.timestamp);
  return {...h, context:[...before,...after]};
});
'''
            script_path=out / 'queries' / mode / (label+'.js')
            script_path.write_text(script)
            args=['--query',str(script_path)]
        rows=run(args,target)
        commands[-1].update({'query':query,'mode':mode,'label':label,'stdoutPath':str(target)})
        expected={(r['sessionId'],r['uuid']) for r in manifest['groundTruth'][query]}
        if mode=='compact': actual={(r['session_id'],r['uuid']) for r in rows}; snippets=[r.get('snippet') or '' for r in rows]
        else: actual={(r['session']['id'],r['message']['uuid']) for r in rows}; snippets=[r['message'].get('text') or '' for r in rows]
        correct=actual & expected
        visible=sum(all(term.casefold() in text.casefold() for term in query.split()) for text in snippets)
        quality.append({'mode':mode,'query':query,'label':label,'expected':len(expected),'returned':len(rows),'truePositives':len(correct),'falsePositives':len(actual-expected),'falseNegatives':len(expected-actual),'precision':len(correct)/len(actual) if actual else None,'recall':len(correct)/len(expected) if expected else None,'correctEmpty':not actual if not expected else None,'visibleQueryMatches':visible,'snippetMatchCoverage':visible/len(rows) if rows else None,'stdoutBytes':target.stat().st_size,'identitiesMatch':actual==expected,'missingIdentities':[{'sessionId':sid,'uuid':uid} for sid,uid in sorted(expected-actual)]})
(out / 'commands.json').write_text(json.dumps({'commit':'69d9e21a90e55f310376d8f49929b1c16f5a1f0c','cliPackageVersion':'0.2.6-rc.0','nodeVersion':subprocess.check_output(['node','--version'],text=True).strip(),'sourceExecution':True,'providerRoots':roots,'commands':commands},ensure_ascii=False,indent=2)+'\n')
(out / 'quality.json').write_text(json.dumps(quality,ensure_ascii=False,indent=2)+'\n')
for row in quality:
    print(json.dumps({k:row[k] for k in ('mode','query','expected','returned','truePositives','visibleQueryMatches','stdoutBytes')},ensure_ascii=False))
