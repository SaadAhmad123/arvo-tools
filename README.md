# @arvo-tools

**Official standard library ecosystem for Arvo applications**

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

## Overview

`@arvo-tools` is the standard library monorepo for the Arvo event-driven ecosystem. While Arvo core defines fundamental abstractions and interfaces for building event-driven applications, this monorepo provides production-ready implementations of those abstractions that developers can adopt immediately without building infrastructure from scratch. Each package in this ecosystem implements the same core Arvo interfaces but targets different deployment contexts, runtime environments, and operational requirements. This enables developers to write business logic once against stable interfaces, then swap infrastructure implementations based on deployment needs without modifying handler code.

The repository embodies Arvo's architectural philosophy of separating application logic from operational concerns. It exists exclusively in the infrastructure layer, containing implementations that solve real operational problems developers encounter when deploying Arvo applications to production. Packages address specific infrastructure challenges like state persistence, event routing, concurrency control, AI integration, observability tooling, and system adapters while maintaining strict adherence to interface contracts defined by Arvo core.

## Architecture and Design Philosophy

Arvo's architecture deliberately separates three layers. The core layer defines abstractions and interfaces that remain stable across implementations. The application layer contains business logic expressed through event handlers, workflows, and contracts. The infrastructure layer provides concrete implementations of core abstractions that handle operational concerns. This monorepo occupies the infrastructure layer and also provides application layer constructs as well, implementing core interfaces without extending them or introducing business logic.

The design follows several key principles. Interface adherence over feature addition ensures all implementations remain compatible and swappable. Deployment context specificity means each package makes appropriate trade-offs for its target environment, whether single-process workloads or distributed systems. Separation of concerns keeps infrastructure implementations completely agnostic to application domains. Swappable implementations allow changing deployment strategies through dependency updates and configuration changes, never through handler logic modifications.

The monorepo structure enables coordinated development of related infrastructure packages while maintaining clear boundaries between them. Each package maintains independent semantic versioning, documentation, and release cycles. They share common development tooling and testing infrastructure but remain independently consumable. Applications depend only on specific packages they need, avoiding unnecessary dependencies while enabling cross-package integration when operational requirements demand combining multiple implementations.

## Ecosystem Relationship and Evolution

The relationship to Arvo follows strict dependency direction. Packages in this monorepo depend on core Arvo interface definitions, type contracts, and base utilities. Arvo never depends on anything in this monorepo. This ensures core abstractions remain stable while infrastructure implementations evolve to meet changing operational needs. Production applications need concrete implementations of core abstractions, but different applications have fundamentally different operational requirements. The monorepo accommodates this diversity without forcing one-size-fits-all approaches.

Community contributions expand the ecosystem by providing implementations for additional deployment contexts, runtime environments, and integration scenarios. New packages emerge when developers encounter operational requirements not addressed by existing implementations. The monorepo structure accommodates this growth while maintaining consistency in development practices, documentation standards, and release processes. Choosing between packages requires understanding deployment context and operational constraints, with each package's documentation articulating its intended use case, characteristics, and trade-offs.

The ecosystem grows as Arvo matures and new operational requirements emerge. Packages addressing proven infrastructure patterns reach stable releases and long-term support. Experimental packages explore emerging deployment models and integration patterns. The structure accommodates both while maintaining clear stability signals for production users. Future growth includes implementations targeting additional persistence backends, alternative event routing strategies, enhanced observability integrations, performance optimization variants, and adapters for emerging runtime environments.
