
# Project Structure and File Safety Rules

## Project Organization

The project will contain these major areas:

- frontend/ — React user interface, owned by Aathavan.
- backend/ — Agent orchestration and repair coordination, owned by Dhanashri.
- .kiro/steering/ — Persistent project instructions.
- README.md — Project documentation.

## Ownership Rules

### Frontend
- Aathavan leads frontend development.
- Frontend components must remain separate from backend agent logic.
- Backend integration must use documented interfaces.

### Backend and Agents
- Dhanashri leads agent architecture and backend coordination.
- Agent instructions and orchestration logic must remain organized.
- Keep Poltergeist and Exorcist responsibilities separate.

## File Modification Safety

- Never modify files outside the approved project directory.
- Never modify secrets, credentials, environment files, or system files.
- Never modify project configuration without explicit approval.
- Poltergeist may only modify explicitly approved test components.
- Exorcist must propose and validate repairs before applying them.
- Preserve a recoverable snapshot before code modifications.
- Never overwrite unrelated work.
- Review every generated patch before accepting it.

## Development Rules

- Use separate Git branches for independent work.
- Review changes before merging into main.
- Make small, testable commits.
- Keep a record of injected failures and repairs.
- Run verification after each repair.
- Report recovery only when verification succeeds.

## Current Restriction

Do not generate the complete application yet.

First establish and review the architecture, interfaces, and safety boundaries.
