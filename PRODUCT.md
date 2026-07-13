# Product

## Register

product

## Users

Kanban serves software developers who coordinate multiple coding agents across one or more repositories. They need to create work, run agents in isolated worktrees, monitor progress, review changes, and hand completed work back without losing repository context.

## Product Purpose

Kanban replaces an IDE-centered workflow with a task-centered workspace for parallel agent execution. Success means developers can move from task definition through agent execution and code review with clear state, predictable controls, and minimal manual terminal or worktree management.

## Brand Personality

Focused, trustworthy, and technically direct. The interface should feel like a dependable developer tool: dense enough for active work, calm under high agent activity, and explicit about consequential actions.

## Anti-references

- Decorative SaaS dashboards that trade information density for oversized cards and promotional copy.
- Novel controls that obscure familiar form, terminal, Git, or task-management behavior.
- Inconsistent agent-specific interfaces that make the same workflow behave differently without a technical reason.
- Low-contrast dark interfaces that make secondary information difficult to read.

## Design Principles

- Keep the developer's current task and repository context visible.
- Use one consistent interaction for equivalent work across agents and views.
- Make defaults safe and reversible while keeping advanced controls discoverable.
- Show operational state and failures directly instead of hiding them behind optimistic UI.
- Prefer compact, familiar controls that preserve flow during repeated task operations.

## Accessibility & Inclusion

Use accessible headless primitives, keyboard-operable controls, visible focus states, readable contrast, reduced-motion-safe transitions, and layouts that remain usable at narrow desktop and mobile widths. Do not encode status by color alone, and preserve the existing high-contrast theme support.
