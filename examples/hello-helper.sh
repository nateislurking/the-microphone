#!/usr/bin/env bash
# ============================================================================
#  hello-helper.sh -- the smallest complete elevated helper.
#
#  It reaches nothing and changes nothing. Its whole job is to prove the round
#  trip works: an armed turn ran this script, and the secret arrived in its
#  environment rather than on its command line.
#
#  Copy it to helpers/, add it to mic.config.json, arm a turn, and look at the
#  FOREMAN-LEDGER.md row it produces. Do that once before you point a real
#  helper at a real account.
#
#  Follows all five rules from examples/README.md:
#    - nothing about the destination is an argument (there is no destination)
#    - the secret comes from the environment, never argv
#    - set -euo pipefail, and a missing secret stops the script
#    - it does exactly one thing
#    - it is harmless, and says so
# ============================================================================
set -euo pipefail

# Fail closed. If you mapped HELLO_SECRET in mic.config.json and it is not here,
# something is wrong with the wiring and you want to know now, loudly.
: "${HELLO_SECRET:?HELLO_SECRET not set — this runs on an ARMED turn only}"

message="${1:?usage: hello-helper.sh <message>}"

echo "hello-helper: it ran."
echo "  message : ${message}"
# Never print a secret. Prove it arrived by its shape, not its value -- the same
# discipline every real helper needs, practised somewhere it costs nothing.
echo "  secret  : received, ${#HELLO_SECRET} characters (never printed)"
