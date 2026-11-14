import json, os, collections, statistics as st
plan = json.load(open('plan.json')); key = json.load(open('key.json')); sc = json.load(open('scenarios.json'))['scenarios']
calls = [json.loads(l) for l in open('calls.jsonl')]
usage = {}
for line in open('usage.txt'):
    s, k, tok, sec = line.split(); usage[(s, int(k))] = (int(tok), float(sec))
order = collections.defaultdict(list)
for r in plan: order[r['scenario']].append(r['session'])
rows = []
for s in sc:
    if not os.path.exists(f'verdict-{s}.json'): continue
    v = json.load(open(f'verdict-{s}.json'))['runs']
    for rid, items in v.items():
        r = key[rid]; sess = r['session']
        mine = [c for c in calls if c.get('session') == sess and c.get('kind') == 'call']
        tube = [c for c in mine if not c.get('rival')]
        bad = [c for c in tube if c['isError'] or c['status'] in ('rejected', 'invalid_change', 'leg_failed', 'no_plan', 'not_tracking', 'not_saved', 'stop_not_found', 'hidden_tool')]
        verdicts = {k: x['verdict'] for k, x in items.items()}
        tok, sec = usage.get((s, order[s].index(sess) + 1), (None, None))
        rows.append({**r, 'run': rid, 'verdicts': verdicts, 'passed': sum(x == 'pass' for x in verdicts.values()), 'items': len(verdicts), 'all_pass': all(x == 'pass' for x in verdicts.values()),
                     'calls': len(mine), 'tube_calls': len(tube), 'rival_calls': len(mine) - len(tube), 'bad': len(bad), 'tokens': tok, 'secs': sec, 'why': {k: x['why'] for k, x in items.items() if x['verdict'] != 'pass'}})
json.dump(rows, open('results.json', 'w'), indent=1)
def show(label, group):
    if not group: return
    items = sum(r['items'] for r in group); passed = sum(r['passed'] for r in group)
    print(f"{label:34} runs={len(group):2} items passed={passed:3}/{items:3} ({100*passed/items:4.0f}%)  runs all-pass={sum(r['all_pass'] for r in group):2}/{len(group):2}  calls={st.mean(r['calls'] for r in group):5.1f}  bad={sum(r['bad'] for r in group):2}  tokens={st.mean(r['tokens'] for r in group if r['tokens']):7.0f}  secs={st.mean(r['secs'] for r in group if r['secs']):5.1f}")
print('graded runs', len(rows))
for shape in ('before', 'merged'): show('shape=' + shape, [r for r in rows if r['shape'] == shape])
for manual in (True, False): show('instructions=' + ('on' if manual else 'off'), [r for r in rows if r['manual'] == manual])
for shape in ('before', 'merged'):
    for manual in (True, False): show(f'{shape}, instructions {"on" if manual else "off"}', [r for r in rows if r['shape'] == shape and r['manual'] == manual])
for model in ('sonnet', 'haiku'): show('model=' + model, [r for r in rows if r['model'] == model])
for s in sc: show('scenario ' + s, [r for r in rows if r['scenario'] == s])
print()
for s in sc:
    items = sorted({k for r in rows if r['scenario'] == s for k in r['verdicts']})
    for k in items:
        g = [r for r in rows if r['scenario'] == s]
        if not g: continue
        f = lambda cond: f"{sum(r['verdicts'].get(k) == 'pass' for r in g if cond(r))}/{sum(1 for r in g if cond(r))}"
        print(f"{s} {k}: all {f(lambda r: True)} | before {f(lambda r: r['shape']=='before')} merged {f(lambda r: r['shape']=='merged')} | instr on {f(lambda r: r['manual'])} off {f(lambda r: not r['manual'])} | sonnet {f(lambda r: r['model']=='sonnet')} haiku {f(lambda r: r['model']=='haiku')}")
