#!/bin/bash
# Beispiel-Bootstrap für einen Cloud-Host (OMP_CLOUD_USERDATA_FILE). {{token}} und {{host}} ersetzt der
# Orchestrator je Host; das Token ist einmalig und eine Stunde gültig (ARCHITECTURE.md §18.3).
# Anpassen: Pfade, Orchestrator-Adresse (erreichbar aus der Cloud, z. B. über VPN), Image mit omp-host-agent.
set -euo pipefail
cat >/etc/omp-host-agent.env <<'ENV'
OMP_HOST_AGENT_LABEL={{host}}
OMP_HOST_AGENT_BOOTSTRAP_TOKEN={{token}}
OMP_ORCHESTRATOR_URL=https://orchestrator.example.internal:8000
ENV
chmod 600 /etc/omp-host-agent.env
systemctl enable --now omp-host-agent
