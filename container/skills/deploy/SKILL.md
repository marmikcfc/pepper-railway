---
name: deploy
description: Deploy code to Railway or Fly.io using API tokens. Covers creating projects, services, and triggering deployments via curl — no CLI required.
inputs:
  - name: RAILWAY_TOKEN
    description: Railway API token (org-level) — required for Railway deployments
  - name: FLY_API_TOKEN
    description: Fly.io personal access token — required for Fly.io deployments
---

## Credentials check

Before any deployment, check which platforms are available:

```bash
echo "Railway token set: $([ -n "$RAILWAY_TOKEN" ] && echo YES || echo NO)"
echo "Fly.io token set:  $([ -n "$FLY_API_TOKEN" ] && echo YES || echo NO)"
```

If neither is set, tell the user:
> "To deploy on Railway, add RAILWAY_TOKEN in Settings → Environment. To deploy on Fly.io, add FLY_API_TOKEN. You can get a Railway token at railway.app/account/tokens and a Fly token with \`fly auth token\`."

---

# Railway Deployment (GraphQL API)

**Endpoint:** `https://backboard.railway.app/graphql/v2`  
**Auth:** `Authorization: Bearer $RAILWAY_TOKEN`  
**All operations are POST with a JSON body.**

## Step 1 — Find your team ID

```bash
curl -s -X POST https://backboard.railway.app/graphql/v2 \
  -H "Authorization: Bearer $RAILWAY_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"query":"{ me { teams { edges { node { id name } } } } }"}' \
  | jq '.data.me.teams.edges[] | {id: .node.id, name: .node.name}'
```

Save the `id` of the team you want to deploy into:

```bash
RAILWAY_TEAM_ID="<team-id-from-above>"
```

## Step 2 — Create a project

```bash
PROJECT_ID=$(curl -s -X POST https://backboard.railway.app/graphql/v2 \
  -H "Authorization: Bearer $RAILWAY_TOKEN" \
  -H "Content-Type: application/json" \
  -d "{\"query\":\"mutation { projectCreate(input: { name: \\\"my-app\\\", teamId: \\\"$RAILWAY_TEAM_ID\\\" }) { id } }\"}" \
  | jq -r '.data.projectCreate.id')

echo "Project ID: $PROJECT_ID"
```

## Step 3 — Get the default environment ID

Every Railway project has at least one environment ("production"). You need its ID for deployments.

```bash
ENV_ID=$(curl -s -X POST https://backboard.railway.app/graphql/v2 \
  -H "Authorization: Bearer $RAILWAY_TOKEN" \
  -H "Content-Type: application/json" \
  -d "{\"query\":\"{ project(id: \\\"$PROJECT_ID\\\") { environments { edges { node { id name } } } } }\"}" \
  | jq -r '.data.project.environments.edges[0].node.id')

echo "Environment ID: $ENV_ID"
```

## Step 4a — Create a service from a GitHub repo

Railway will auto-deploy on every push to the repo's default branch.

```bash
SERVICE_ID=$(curl -s -X POST https://backboard.railway.app/graphql/v2 \
  -H "Authorization: Bearer $RAILWAY_TOKEN" \
  -H "Content-Type: application/json" \
  -d "{\"query\":\"mutation { serviceCreate(input: { projectId: \\\"$PROJECT_ID\\\", name: \\\"web\\\", source: { repo: \\\"owner/repo\\\" } }) { id } }\"}" \
  | jq -r '.data.serviceCreate.id')

echo "Service ID: $SERVICE_ID"
```

## Step 4b — Create a service from a Docker image

```bash
SERVICE_ID=$(curl -s -X POST https://backboard.railway.app/graphql/v2 \
  -H "Authorization: Bearer $RAILWAY_TOKEN" \
  -H "Content-Type: application/json" \
  -d "{\"query\":\"mutation { serviceCreate(input: { projectId: \\\"$PROJECT_ID\\\", name: \\\"web\\\", source: { image: \\\"ghcr.io/owner/repo:latest\\\" } }) { id } }\"}" \
  | jq -r '.data.serviceCreate.id')
```

## Step 5 — Set environment variables on the service

```bash
curl -s -X POST https://backboard.railway.app/graphql/v2 \
  -H "Authorization: Bearer $RAILWAY_TOKEN" \
  -H "Content-Type: application/json" \
  -d "{\"query\":\"mutation { variableCollectionUpsert(input: { projectId: \\\"$PROJECT_ID\\\", environmentId: \\\"$ENV_ID\\\", serviceId: \\\"$SERVICE_ID\\\", variables: { PORT: \\\"3000\\\", NODE_ENV: \\\"production\\\" } }) }\"}"
```

## Step 6 — Trigger a redeployment

Use this to force a new deploy (e.g. after updating env vars or pushing a new image):

```bash
curl -s -X POST https://backboard.railway.app/graphql/v2 \
  -H "Authorization: Bearer $RAILWAY_TOKEN" \
  -H "Content-Type: application/json" \
  -d "{\"query\":\"mutation { serviceInstanceRedeploy(serviceId: \\\"$SERVICE_ID\\\", environmentId: \\\"$ENV_ID\\\") }\"}" \
  | jq .
```

## Step 7 — Check deployment status

```bash
curl -s -X POST https://backboard.railway.app/graphql/v2 \
  -H "Authorization: Bearer $RAILWAY_TOKEN" \
  -H "Content-Type: application/json" \
  -d "{\"query\":\"{ deployments(input: { serviceId: \\\"$SERVICE_ID\\\", environmentId: \\\"$ENV_ID\\\" }) { edges { node { id status createdAt } } } }\"}" \
  | jq '.data.deployments.edges[0].node'
```

Status values: `BUILDING` → `DEPLOYING` → `SUCCESS` or `FAILED`.

## Get the public URL of a deployed service

```bash
curl -s -X POST https://backboard.railway.app/graphql/v2 \
  -H "Authorization: Bearer $RAILWAY_TOKEN" \
  -H "Content-Type: application/json" \
  -d "{\"query\":\"{ serviceInstance(serviceId: \\\"$SERVICE_ID\\\", environmentId: \\\"$ENV_ID\\\") { domains { serviceDomains { domain } } } }\"}" \
  | jq -r '.data.serviceInstance.domains.serviceDomains[0].domain'
```

---

# Fly.io Deployment (Machines API)

**Base URL:** `https://api.machines.dev/v1`  
**Auth:** `Authorization: Bearer $FLY_API_TOKEN`  
**Requires a Docker image in a public or authenticated registry.**

## Step 1 — Find your org slug

```bash
curl -s -X POST https://api.fly.io/graphql \
  -H "Authorization: Bearer $FLY_API_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"query":"{ organizations { nodes { id slug name type } } }"}' \
  | jq '.data.organizations.nodes[] | {slug: .slug, name: .name, type: .type}'
```

Use `type: PERSONAL` slug for personal deployments, or your team slug.

```bash
FLY_ORG="personal"   # or your org slug
```

## Step 2 — Create an app

App names must be globally unique on Fly.io.

```bash
APP_NAME="my-app-$(date +%s)"   # unique suffix to avoid collisions

curl -s -X POST "https://api.machines.dev/v1/apps" \
  -H "Authorization: Bearer $FLY_API_TOKEN" \
  -H "Content-Type: application/json" \
  -d "{\"app_name\": \"$APP_NAME\", \"org_slug\": \"$FLY_ORG\"}" \
  | jq '{name: .name, status: .status}'
```

## Step 3 — Allocate a public IP (for HTTP traffic)

```bash
curl -s -X POST "https://api.machines.dev/v1/apps/$APP_NAME/ips" \
  -H "Authorization: Bearer $FLY_API_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"type": "shared_v4"}' \
  | jq .
```

## Step 4 — Create and start a machine

This deploys your Docker image as a running VM. Adjust `DOCKER_IMAGE`, `PORT`, and `env` as needed.

```bash
DOCKER_IMAGE="ghcr.io/owner/repo:latest"
PORT=3000

MACHINE_ID=$(curl -s -X POST "https://api.machines.dev/v1/apps/$APP_NAME/machines" \
  -H "Authorization: Bearer $FLY_API_TOKEN" \
  -H "Content-Type: application/json" \
  -d "{
    \"config\": {
      \"image\": \"$DOCKER_IMAGE\",
      \"env\": {
        \"PORT\": \"$PORT\",
        \"NODE_ENV\": \"production\"
      },
      \"services\": [
        {
          \"ports\": [
            {\"port\": 443, \"handlers\": [\"tls\", \"http\"]},
            {\"port\": 80,  \"handlers\": [\"http\"]}
          ],
          \"protocol\": \"tcp\",
          \"internal_port\": $PORT
        }
      ],
      \"checks\": {
        \"alive\": {
          \"type\": \"http\",
          \"port\": $PORT,
          \"path\": \"/\",
          \"interval\": \"15s\",
          \"timeout\": \"10s\"
        }
      }
    }
  }" \
  | jq -r '.id')

echo "Machine ID: $MACHINE_ID"
```

## Step 5 — Wait for the machine to start

```bash
curl -s "https://api.machines.dev/v1/apps/$APP_NAME/machines/$MACHINE_ID/wait?state=started&timeout=60" \
  -H "Authorization: Bearer $FLY_API_TOKEN" \
  | jq .
```

Returns `{"ok": true}` when the machine is running.

## Step 6 — Check machine status

```bash
curl -s "https://api.machines.dev/v1/apps/$APP_NAME/machines/$MACHINE_ID" \
  -H "Authorization: Bearer $FLY_API_TOKEN" \
  | jq '{id: .id, state: .state, region: .region, image: .config.image}'
```

State values: `created` → `starting` → `started` or `failed`.

## Step 7 — Update/redeploy (replace image)

To deploy a new image version, update the machine config:

```bash
curl -s -X POST "https://api.machines.dev/v1/apps/$APP_NAME/machines/$MACHINE_ID" \
  -H "Authorization: Bearer $FLY_API_TOKEN" \
  -H "Content-Type: application/json" \
  -d "{\"config\": {\"image\": \"ghcr.io/owner/repo:v2\"}}" \
  | jq '{id: .id, state: .state}'
```

## Step 8 — List all machines in an app

```bash
curl -s "https://api.machines.dev/v1/apps/$APP_NAME/machines" \
  -H "Authorization: Bearer $FLY_API_TOKEN" \
  | jq '.[] | {id: .id, state: .state, region: .region}'
```

## Get app hostname

Fly.io apps are available at `$APP_NAME.fly.dev` once deployed. Verify:

```bash
curl -s -X POST https://api.fly.io/graphql \
  -H "Authorization: Bearer $FLY_API_TOKEN" \
  -H "Content-Type: application/json" \
  -d "{\"query\":\"{ app(name: \\\"$APP_NAME\\\") { hostname status } }\"}" \
  | jq '.data.app'
```

---

# Decision Guide

| Situation | Use |
|-----------|-----|
| Have a GitHub repo, want auto-deploy on push | Railway (Step 4a) |
| Have a Docker image already built | Railway (Step 4b) or Fly.io |
| Need fine-grained VM control (regions, resources) | Fly.io |
| Simplest setup with minimal config | Railway |
| Need HTTP services with TLS out of the box | Either — both auto-provision TLS |

## Building a Docker image before deploying

If the code isn't containerized yet, the agent must build and push first:

```bash
# Build the image
docker build -t ghcr.io/owner/repo:latest .

# Push to GitHub Container Registry
echo "$GH_TOKEN" | docker login ghcr.io -u owner --password-stdin
docker push ghcr.io/owner/repo:latest
```

Then use `ghcr.io/owner/repo:latest` as the image in Railway Step 4b or Fly.io Step 4.
