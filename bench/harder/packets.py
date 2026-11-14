# Builds one blind grading packet per scenario: no condition, no model, no session id.
import json, random, subprocess, sys
plan = json.load(open('plan.json')); sc = json.load(open('scenarios.json'))['scenarios']
calls = [json.loads(l) for l in open('calls.jsonl')]
key = {}
for s in sys.argv[1:]:
    runs = [r for r in plan if r['scenario'] == s]
    random.shuffle(runs)
    packet = {'scenario': sc[s]['title'], 'user_messages': sc[s]['messages'], 'rubric': sc[s]['rubric'], 'context': 'Before this conversation the travel server already held: home = E20 2ST, work = Liverpool Street, gym = EC2R 8AH, and a preference to avoid buses. The conversation took place on Saturday 14 November 2026, early afternoon, London time. Tools named tube__* belong to the travel server; all other tools belong to other connectors.', 'runs': []}
    for i, r in enumerate(runs):
        rid = f'{s}-run{i+1}'; key[rid] = r
        mine = [c for c in calls if c.get('session') == r['session']]
        state = json.loads(subprocess.check_output(['./mcp', r['session'], 'state']))
        replies = {}
        for c in mine:
            if c.get('kind') == 'reply': replies[str(c['n'])] = c['text']
        log = [{'tool': c['tool'], 'arguments': c.get('args'), 'outcome': c.get('status'), 'result': c.get('result')} for c in mine if c.get('kind') == 'call']
        packet['runs'].append({'run': rid, 'replies_by_message_number': replies, 'tool_calls_in_order': log, 'final_saved_state_on_travel_server': state})
    json.dump(packet, open(f'packet-{s}.json', 'w'), indent=1)
    print(s, len(packet['runs']), 'runs', len(json.dumps(packet)), 'chars')
old = json.load(open('key.json')) if __import__('os').path.exists('key.json') else {}
old.update(key); json.dump(old, open('key.json', 'w'), indent=1)
