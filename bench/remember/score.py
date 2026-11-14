import json, sys, subprocess, statistics as st
runs = json.load(open('runs.json'))
calls = [json.loads(l) for l in open('calls.jsonl')]
WRITERS = {'save_place', 'forget_place', 'set_travel_preferences', 'remember'}
def op(c):
    """Normalise a remember-type call to (operation, args) so both variants score alike."""
    a = c.get('args') or {}
    if c['tool'] == 'remember': return a.get('action'), a
    return {'save_place': 'save_place', 'forget_place': 'forget_place', 'set_travel_preferences': 'set_preferences'}.get(c['tool']), a
rows = []
for r in runs:
    mine = [c for c in calls if c.get('session') == r['session'] and not c.get('scoring')]
    cs = [c for c in mine if c.get('kind') == 'call']
    if not cs: rows.append({**r, 'done': False}); continue
    final = json.loads(subprocess.check_output(['./tube', r['session'], 'call', 'get_operating_instructions', '{}']))
    places = {p['label']: p['place'] for p in final['saved_places']['places']}
    avoid = final['travel_preferences']['avoid_modes']
    norm = lambda s: s.replace(' ', '').upper()
    state_ok = set(places) == {'home', 'gym'} and norm(places.get('home', '')) == 'E202ST' and norm(places.get('gym', '')) == 'EC2R8AH' and avoid == ['cable-car']
    errors = [c for c in cs if c['isError'] or c['status'] in ('rejected', 'not_found', 'invalid_change')]
    writes = [c for c in cs if c['tool'] in WRITERS]
    ops = [op(c)[0] for c in writes]
    # Expected writes: save home, save work, prefs, save home, forget work, prefs, save gym = 7 (4 saves, 1 forget, 2 prefs)
    extra_writes = max(0, len([c for c in writes if c not in errors]) - 7)
    plans = [c for c in cs if c['tool'] in ('plan_journey', 'show_journey', 'track_journey')]
    knee = next((c for c in plans if 'tube' in ((c.get('args') or {}).get('exclude_modes') or [])), None)
    knee_modes = sorted((knee.get('args') or {}).get('exclude_modes')) if knee else None
    t0, t1 = mine[0]['ts'], mine[-1]['ts']
    from datetime import datetime
    secs = (datetime.fromisoformat(t1.replace('Z', '+00:00')) - datetime.fromisoformat(t0.replace('Z', '+00:00'))).total_seconds()
    rows.append({**r, 'done': True, 'state_ok': state_ok, 'places': places, 'avoid': avoid, 'calls': len(cs), 'errors': len(errors), 'error_detail': [(c['tool'], c['args'], c['status']) for c in errors],
                 'writes': len(writes), 'ops': ops, 'extra_writes': extra_writes, 'knee_exclude': knee_modes, 'seconds': round(secs),
                 'tool_chars_in': sum(c['response_chars'] for c in mine), 'tool_chars_out': sum(c['request_chars'] for c in mine), 'lists': len([c for c in mine if c.get('kind') == 'list']),
                 'sequence': [c['tool'] + (':' + (c['args'] or {}).get('action', '') if c['tool'] == 'remember' else '') for c in cs]})
json.dump(rows, open('scores.json', 'w'), indent=1)
for row in rows:
    if not row['done']: print(row['variant'], row['model'], row['rep'], 'NOT RUN'); continue
    print(f"{row['variant']:9}{row['model']:7}#{row['rep']} state_ok={row['state_ok']!s:5} calls={row['calls']:2} errors={row['errors']} extra_writes={row['extra_writes']} knee={row['knee_exclude']} secs={row['seconds']:4} in={row['tool_chars_in']:6} out={row['tool_chars_out']:5}")
    print('   ', ' '.join(row['sequence']))
    if row['errors']: print('    errors:', row['error_detail'])
    if not row['state_ok']: print('    state:', row['places'], row['avoid'])
