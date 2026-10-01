cd /home/infantilo/OpenMediaPlatform/nodes
fails=0
for i in $(seq 1 $1); do
  bash /tmp/claude-1000/startmixer.sh; python3 /tmp/claude-1000/ui/seed.py 8 >/dev/null; sleep 1
  r=$(python3 - <<'PY'
exec(open('/tmp/claude-1000/t7.py').read().split('print("fresh:"')[0])
l=levels(1.0); print("missing:", [f"ch{i}" for i in range(1,9) if f"ch{i}" not in l], "master", l.get("None"))
PY
)
  if echo "$r" | grep -q "ch[0-9]\|master None"; then fails=$((fails+1)); echo "run $i: $r"; grep DBGCNT /tmp/claude-1000/mixer.log | tail -3 | cut -c1-300; cp /tmp/claude-1000/mixer.log /tmp/claude-1000/mixer.fail.$i.log; fi
done
echo "STRESS DONE fails=$fails of $1"
