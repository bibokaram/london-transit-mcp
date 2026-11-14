import json, subprocess
from datetime import datetime
runs = json.load(open('runs.json'))
calls = [json.loads(l) for l in open('calls.jsonl')]
BAD = ('rejected', 'not_found', 'invalid_change', 'leg_failed', 'no_plan', 'not_tracking', 'not_saved', 'stop_not_found')
def name(c):
    a = c.get('args') or {}
    return c['tool'] + (':' + a['action'] if 'action' in a else '')
rows = []
for r in runs:
    mine = [c for c in calls if c.get('session') == r['session']]
    cs = [c for c in mine if c.get('kind') == 'call']
    if not cs: print(r, 'NOT RUN'); continue
    shown = json.loads(subprocess.check_output(['./tube', r['session'], 'call', 'remember', '{"action":"show"}']))['remembered']
    places = {p['label']: p['place'] for p in shown['places']}
    state_ok = set(places) == {'home'} and shown['avoid_modes'] == ['bus'] and shown['followed_journeys'] == []
    errors = [c for c in cs if c['isError']]
    bad = [c for c in cs if not c['isError'] and c['status'] in BAD]
    ambig = [c for c in cs if c['status'] == 'needs_disambiguation']
    seq = [name(c) for c in cs]
    followed_hc = any(('follow_as' in (c.get('args') or {}) or (c.get('args') or {}).get('label')) and 'hammersmith' in json.dumps(c.get('args')) and c['status'] == 'ok' for c in cs)
    lookups = sum(1 for c in cs if c['tool'] == 'find_stop')
    secs = (datetime.fromisoformat(mine[-1]['ts'].replace('Z', '+00:00')) - datetime.fromisoformat(mine[0]['ts'].replace('Z', '+00:00'))).total_seconds()
    row = {**r, 'state_ok': state_ok, 'places': places, 'avoid': shown['avoid_modes'], 'followed': shown['followed_journeys'], 'calls': len(cs), 'errors': len(errors), 'bad': len(bad), 'ambiguous': len(ambig),
           'followed_hc': followed_hc, 'lookups': lookups, 'seconds': round(secs), 'chars_in': sum(c['response_chars'] for c in mine), 'chars_out': sum(c['request_chars'] for c in mine),
           'list_pages': len([c for c in mine if c.get('kind') == 'list']), 'sequence': seq,
           'detail': [(name(c), c['status'], json.dumps(c['args'])[:140]) for c in errors + bad + ambig]}
    rows.append(row)
    print(f"{r['variant']:7}{r['model']:7}#{r['rep']} state_ok={state_ok!s:5} calls={len(cs):2} errors={len(errors)} bad={len(bad)} ambig={len(ambig)} followedHC={followed_hc!s:5} secs={round(secs):4} in={row['chars_in']:6} pages={row['list_pages']}")
    print('    ' + ' '.join(seq))
    for d in row['detail']: print('    !', d)
    if not state_ok: print('    state:', places, shown['avoid_modes'], shown['followed_journeys'])
json.dump(rows, open('scores.json', 'w'), indent=1)
