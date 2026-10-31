"""Verify the synthetic role through ZAP, so a missing auth header cannot silently pass."""
import json
import os

role_verified = False


def zap_started(zap, target):
    global role_verified
    cookie = os.environ.get('ZAP_AUTH_HEADER_VALUE')
    if cookie:
        zap.replacer.add_rule('synthetic-buyer', 'true', 'REQ_HEADER', 'false', 'Cookie',
                              replacement=cookie, url=r'http://127\.0\.0\.1:3000/.*')
    response = zap.urlopen('http://127.0.0.1:3000/api/account')
    expected = '"id":"buyer"' if os.environ.get('ZAP_AUTH_HEADER_VALUE') else '"account":null'
    if expected not in response:
        raise RuntimeError('Synthetic ZAP role verification failed')
    role_verified = True
    print('Synthetic ZAP role verified: ' + ('buyer' if os.environ.get('ZAP_AUTH_HEADER_VALUE') else 'anonymous'))


def zap_pre_shutdown(zap):
    scans = zap.ascan.scans
    messages = zap.core.messages(start=0, count=5000)
    status_counts = {}
    for message in messages:
        status = message.get('responseHeader', '').split('\r\n')[0]
        status_counts[status] = status_counts.get(status, 0) + 1
    with open('/zap/wrk/coverage.json', 'w', encoding='utf-8') as output:
        json.dump({'role': 'buyer' if os.environ.get('ZAP_AUTH_HEADER_VALUE') else 'anonymous',
                   'role_verified': role_verified,
                   'active_scans': scans, 'message_count': zap.core.number_of_messages(),
                   'sampled_messages': len(messages), 'response_status_counts': status_counts}, output, indent=2)
    if not scans:
        raise RuntimeError('No active scan recorded; do not report a completed active DAST scan')
