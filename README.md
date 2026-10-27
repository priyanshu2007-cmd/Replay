# Replay

[![CI](https://github.com/priyanshu2007-cmd/Replay/actions/workflows/ci.yml/badge.svg)](https://github.com/priyanshu2007-cmd/Replay/actions/workflows/ci.yml)
[![Security](https://github.com/priyanshu2007-cmd/Replay/actions/workflows/security.yml/badge.svg)](https://github.com/priyanshu2007-cmd/Replay/actions/workflows/security.yml)

**Quick Summary:** Drop a bug video. Get a failing test and a verified fix.

## What is Replay?

Replay is a revolutionary bug-fixing system that takes screen recordings of web application bugs and automatically generates the complete debugging and fix workflow. It bridges the gap between human bug reporting and automated software engineering.

### The Core Problem It Solves

Traditional bug reporting relies on:
- **Manual reproduction**: Developers must replicate bugs, which can be time-consuming and unreliable
- **Human-only analysis**: Bug reports depend on developers' understanding and skills
- **Inconsistent fixes**: Different developers may produce different solutions
- **Delayed feedback**: Bug fixes often take hours or days to materialize

Replay solves this by:
- **Automatic reproduction**: Converts video recordings into reproducible tests
- **Intelligent analysis**: Uses AI to understand and locate bugs
- **Standardized fixes**: Produces consistent, minimal code patches
- **Immediate results**: Delivers complete bug fixes in real-time

## The 7-Stage Pipeline Architecture

```
video ──▶ Ingest ──▶ Watch ──▶ Locate ──▶ Reproduce ──▶ Verify ──▶ Fix ──▶ Report
          ffmpeg     Super VL  Lightning   Ultra         Super VL   Ultra    Nano
          frames     (vision)  (repo)      (test)        (compare)  (patch)  (report)
                         ▲                                        │
                         └──── deterministic gates, no AI ────────┘
```

### Understanding Each Stage

| Stage | Purpose | What It Produces | Key Technology |
|-------|---------|------------------|-----------------|
| **Ingest** | Extracts video frames | Time-stamped images from recording | FFmpeg frame extraction |
| **Watch** | Analyzes frames to identify bugs | Bug report with expected/actual behavior | NVIDIA Nemotron-3.5-Super-VL |
| **Locate** | Searches codebase for buggy code | Ranked list of suspect files and line numbers | NVIDIA Nemotron-3_5-Lightning |
| **Reproduce** | Creates failing Playwright test | Code that reproduces the exact bug | NVIDIA Nemotron-3-Ultra-550b |
| **Verify** | Confirms reproduction matches video | Verification of test vs video frames | NVIDIA Nemotron-3.5-Super-VL |
| **Fix** | Generates minimal code patch | Surgical code changes to fix the bug | NVIDIA Nemotron-3-Ultra-550b |
| **Report** | Generates comprehensive documentation | Markdown report with proof and evidence | NVIDIA Nemotron-3-Nano |

## Key Technology Stack

### AI Models
- **Nemotron-3.5-Super-VL**: Video analysis and bug pattern recognition
- **Nemotron-3.5-Lightning**: Efficient code search and location
- **Nemotron-3-Ultra-550b**: Test generation and code patch creation
- **Nemotron-3-Nano**: Documentation and reporting

### Frameworks & Tools
- **Backend**: Hono (web framework), Node.js
- **Frontend**: Next.js 15, React
- **Testing**: Playwright (browser automation)
- **Database**: Drizzle ORM, PostgreSQL (Supabase)
- **Storage**: Supabase Storage, local file system
- **Execution**: Docker sandbox for isolated code execution
- **Configuration**: Zod schemas for type safety

### Execution Environment
```
Replay/
├── apps/
│   ├── web/                    # Next.js frontend
│   │   ├── home/              # Landing page
│   │   ├── runs/             # Live run workspace
│   │   ├── benchmark/         # Performance benchmarking
│   │   └── how/              # How-to documentation
│   └── api/                   # Hono API + worker queue
├── packages/
│   ├── agents/              # AI agents and pipeline
│   ├── sandbox/             # Isolated execution environment
│   ├── video/               # Video processing utilities
│   ├── storage/             # Storage abstraction layer
│   ├── db/                  # Database schemas and migrations
│   └── shared/              # Shared contracts and types
├── targets/                 # Test applications with planted bugs
│   └── demo-shop/           # E-commerce React app (5 bugs)
├── samples/                 # Bug recordings and fixtures
│   ├── cart-nan/           # Cart bug sample
│   ├── double-discount/    # Discount bug sample
│   └── ... (5 total)       # Plus 3 more samples
├── eval/                    # Evaluation scripts
│   ├── watcher.js          # Video analysis evaluation
│   ├── locator.js          # Code location evaluation
│   └── ...
└── scripts/                 # Development and maintenance scripts
```

## Getting Started: Local Development

### Prerequisites

```bash
# Install Node.js 22+ and pnpm 10+
corepack enable  # Makes pnpm available

# Required: Nebius Token Factory API key
# Get from: https://console.tokenfactory.nebius.com
# Set NEBIUS_API_KEY in your .env file

# Optional but recommended:
brew install ffmpeg  # For video frame extraction
docker compose up   # For isolated execution environment
```

### Setup Steps

1. **Clone and initialize**

```bash
git clone <repo-url>
cd Replay
pnpm install
```

2. **Configure environment**

```bash
cp .env.example .env
# Edit .env to set required keys:
# - NEBIUS_API_KEY (for model calls)
# - DATABASE_URL (for persistence, optional)
# - SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY (for storage, optional)
```

3. **Start the application**

```bash
# Development mode (3 terminals)
pnpm dev:api        # Hono API + SSE on :3001
pnpm dev:worker     # Queue worker claiming and processing runs
pnpm dev:web        # Next.js frontend on :3000
```

### Environment Variables Reference

| Variable | Required | Purpose | Default |
|----------|----------|---------|---------|
| `NEBIUS_API_KEY` | Yes | Model API key for all AI stages | - |
| `NEBIUS_BASE_URL` | No | Model endpoint URL | `https://api.tokenfactory.nebius.com/v1/` |
| `DATABASE_URL` | No | Database connection string | - |
| `SUPABASE_URL` | No | Supabase storage URL | - |
| `SUPABASE_SERVICE_ROLE_KEY` | No | Supabase admin key | - |
| `NEXT_PUBLIC_API_URL` | No | Frontend API base URL | - |
| `ALLOWED_ORIGINS` | No | CORS allowed origins | - |
| `PORT` | No | API service port | 3001 |

**Security Note**: Never commit `.env` files. Only `NEXT_PUBLIC_*` values should be in version control.

## Core Workflow: How to Use Replay

### Option 1: Command Line Interface

```bash
# Fix a built-in sample bug
pnpm replay cart-nan

# Fix from a video file
pnpm replay /path/to/my-bug.webm

# Fix from a sample recording directory
pnpm replay /path/to/samples/my-bug
```

**Output**: The CLI prints stage traces, verdicts, token totals, and the report path (`artifacts/reports/<runId>.md`)

### Option 2: Web Interface

1. **Navigate**: Open `http://localhost:3000` in your browser
2. **Upload**: Click "Upload Bug Video" or drag-and-drop a video file
3. **Watch**: Monitor real-time progress of each pipeline stage
4. **Review**: See the generated test, fix, and comprehensive report
5. **Apply**: Click "Apply Fix" to verify and deploy the solution

### Option 3: Programmatic API Access

```javascript
// Using the Replay API directly
fetch('http://localhost:3001/api/runs', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    videoPath: '/path/to/video.webm',
    targetId: 'demo-shop'
  })
})
```

## Repository Structure: Understanding the Components

### Targets: Test Applications with Planted Bugs

The `targets/demo-shop` is a complete React + Vite e-commerce application with 5 intentionally planted bugs:

- **cart-nan**: Cart quantity handling bug
- **double-discount**: Coupon stacking bug
- **string-sort**: String sorting bug
- **empty-email**: Checkout email validation bug
- **quantity-reset**: Tab reset behavior bug

Each bug is accessible via a `?bug=<id>` query parameter during development.

### Samples: Real Bug Recordings

Each bug has two components:
1. `samples/<id>/expected.json`: The "golden master" defining the bug's expected behavior
2. `samples/videos/<id>.webm`: Real recording captured via Playwright against the demo shop

### Agents: Specialized AI Components

The agent system uses different NVIDIA Nemotron models optimized for specific tasks:

- **Watcher**: Video analysis and bug pattern recognition
- **Locator**: Code search and bug location
- **Reproducer**: Playwright test generation
- **Verifier**: Test-video verification
- **Fixer**: Code patch generation
- **Reporter**: Documentation and reporting

## Testing and Evaluation

### Running Tests

```bash
# Run all package tests
pnpm test

# Test the demo shop (6 baseline + 5 bug-fixture Playwright tests)
pnpm --filter @replay/demo-shop test

# Test the web frontend (e2e tests with build)
pnpm --filter @replay/web test

# Model smoke tests (verify API keys work)
pnpm smoke:models

# Evaluation tests (benchmark agent performance)
pnpm eval:locator      # Code location accuracy
pnpm eval:reproducer  # Test generation accuracy
pnpm eval:pipeline    # End-to-end fix-and-verify
```

### Sample Bug Benchmarks

Based on live runs from October 25, 2026:

| Bug Sample | Success Rate | Fix Attempts | Duration |
|------------|--------------|-------------|----------|
| `cart-nan` | **FIXED** | 1 | 44.3s |
| `empty-email` | **FIXED** | 1 | 66.0s |
| `quantity-reset` | **FIXED** | 1 | 54.4s |
| `double-discount` | REPRODUCED_ONLY | 2 | 52.3s |
| `string-sort` | REPRODUCED_ONLY | 2 | 61.3s |

**Aggregate Results**: 5/5 reproduced correctly, 5/5 located by top suspect, 3/5 fixed end-to-end

## Deployment and Production

### Local Production Setup

```bash
# Full docker-compose setup (recommended for production)
pnpm install
cp .env.example .env
# Configure your keys in .env
docker compose up
```

This sets up a complete production environment with:
- API service with worker queue
- PostgreSQL database
- Caddy reverse proxy
- Playwright browsers
- Sandboxed execution environment

### Vercel Cloud Deployment

```bash
# Deploy to Vercel (single web service)
vercel deploy
```

**Environment Variables for Vercel**:

- `DATABASE_URL`: Required Supabase connection
- `REPLAY_DATA_DIR=/tmp`: Read-only filesystem
- `ALLOWED_ORIGINS`: Your Vercel app domain
- `NEBIUS_API_KEY`: Optional (used by worker host)

### Database Migrations

```bash
# After schema changes
pnpm --filter @replay/db db:generate
pnpm --filter @replay/db db:migrate
```

## Security and Safety

### Built-in Security Controls

- **Input Validation**: All file paths, URLs, and user inputs are strictly validated
- **Path Traversal Protection**: No access outside the workspace root
- **Sandboxed Execution**: Model-generated code runs in isolated Docker containers
- **Rate Limiting**: 5 requests per IP per hour
- **File Upload Security**: 50MB limit, MIME type validation, virus scanning
- **Environment Isolation**: No secrets leaked to sandboxes
- **Access Control**: Private runs require unguessable IDs + share tokens

### Threat Model

1. **Untrusted Video Uploads**: Videos are analyzed but cannot execute code
2. **Untrusted Model Output**: Generated code only runs in sandboxes
3. **Untrusted Generated Code**: Isolated with network restrictions, read-only file system
4. **Unauthorized Access**: All runs require authentication and authorization
5. **DoS Attacks**: Rate limiting and resource bounds prevent abuse

## Development and Contributing

### Development Workflow

1. **Understanding the Problem**: Use existing samples as a guide
2. **Creating New Bugs**: Follow the bug template in samples/
3. **Testing Locally**: Use `pnpm replay <sampleId>` for quick testing
4. **Adding Features**: Contribute to agent capabilities or UI improvements
5. **Documentation**: Update README, add examples, document new features

### Getting Help

- **Issues**: File issues with detailed reproduction steps
- **Discussions**: Ask questions and share ideas
- **Community**: Join discussions for real-time help

## License

MIT License. See `LICENSE.md` for details.

Third-party notices: The mascot uses `@bible-strong/avatar-core` (AGPL-3.0-only).
See `THIRD_PARTY_NOTICES.md` for complete attribution.

## Quick Start for New Developers

1. **Clone the repo**: `git clone <url>`
2. **Install dependencies**: `pnpm install`
3. **Configure environment**: Copy `.env.example` to `.env` and set `NEBIUS_API_KEY`
4. **Start development**: 
   ```bash
   pnpm dev:api      # API server
   pnpm dev:worker   # Worker queue
   pnpm dev:web      # Web frontend
   ```
5. **Test**: `pnpm replay cart-nan` (run a sample bug fix)
6. **Explore**: Navigate to `http://localhost:3000` to use the web interface

The system is designed to be approachable for new developers while providing powerful capabilities for experienced users.