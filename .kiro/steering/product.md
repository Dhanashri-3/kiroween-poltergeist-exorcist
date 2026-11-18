
# Poltergeist QA vs. The Exorcist

## Project Overview

Build an autonomous AI-vs-AI chaos engineering and self-healing system.

The system uses two agents:

1. Poltergeist — intentionally introduces controlled failures into a test web application.
2. Exorcist — detects failures, investigates their causes, proposes repairs, applies validated fixes, and verifies recovery.

The goal is to demonstrate a real application recovering from intentionally introduced failures.

## Agent Responsibilities

### Poltergeist — Chaos Agent

- Introduce controlled UI failures.
- Operate only on explicitly permitted test files and components.
- Record every injected failure.
- Never modify project configuration, secrets, or unrelated files.
- Allow the Exorcist to inspect and repair the failure.

### Exorcist — Self-Healing Agent

- Monitor the test application for failures.
- Identify the affected component.
- Investigate the likely root cause.
- Generate a minimal repair.
- Validate the proposed changes before applying them.
- Run appropriate verification checks.
- Report recovery only after successful verification.
- Roll back unsuccessful repairs when possible.

## Core Workflow

1. Start the test application.
2. Poltergeist injects a controlled failure.
3. The system detects the failure.
4. Exorcist investigates the root cause.
5. Exorcist generates a repair.
6. The repair is validated and applied safely.
7. Tests verify the repaired application.
8. The dashboard displays the result.

## Safety Requirements

- Run experiments only in an isolated test environment.
- Never attack external websites or production systems.
- Never expose credentials, API keys, or personal data.
- Restrict file modifications to approved test files.
- Preserve a recoverable version before applying repairs.
- Never claim a repair succeeded without verification.
- Keep an event log of chaos, detection, repair, and verification.

## Demonstration Goal

Judges should be able to watch a controlled UI failure happen, see the Exorcist diagnose and repair it, and observe the application return to a verified healthy state.

## Development Principles

- Build incrementally.
- Keep frontend and agent logic separate.
- Prefer understandable, testable implementations.
- Review generated code before accepting it.
- Do not replace real agent behavior with simulated success messages.
