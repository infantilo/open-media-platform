#!/bin/bash
# Pro-Thread-CPU des Nodes über ein Fenster: threads.sh <pid> <sekunden>
PID=$1; W=${2:-10}
snap() { for t in /proc/$PID/task/*; do echo "$(basename $t) $(cat $t/comm | tr ' ' '_') $(awk '{print $14+$15}' $t/stat 2>/dev/null)"; done; }
snap > /tmp/thr0.$$; sleep $W; snap > /tmp/thr1.$$
join <(sort /tmp/thr0.$$) <(sort /tmp/thr1.$$) | awk -v w=$W '{d=($5-$3)/100; n=$2; gsub(/[0-9]+/,"N",n); a[n]+=d; c[n]++} END{for(k in a) printf "%5.1f %%  %s (%d)\n", 100*a[k]/w, k, c[k]}' | sort -rn | head -12
rm -f /tmp/thr0.$$ /tmp/thr1.$$
