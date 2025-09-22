# Overview

This is a Notion API integration project that provides a wrapper for connecting to Notion databases using Replit's connector system. The application handles OAuth authentication through Replit's connectors and creates authenticated Notion clients for database operations. The codebase is primarily focused on establishing secure connections to Notion and appears to be in early development with Korean comments suggesting database interaction functionality.

# User Preferences

Preferred communication style: Simple, everyday language.

# System Architecture

## Authentication System
The project uses Replit's connector authentication system to manage Notion API access tokens. The authentication flow includes:
- Token validation and expiration checking
- Automatic token refresh through Replit's connector API
- Support for both repl (`REPL_IDENTITY`) and deployment (`WEB_REPL_RENEWAL`) environments
- Secure credential storage through Replit's secrets management

## Client Management
The architecture deliberately avoids caching Notion clients due to token expiration concerns:
- `getUncachableNotionClient()` function creates fresh clients on each call
- Access token retrieval is handled separately to allow for token refresh logic
- Error handling for missing connections and invalid tokens

## Module Structure
- ES6 module system with `type: "module"` configuration
- Single entry point (`index.js`) containing core authentication and client creation logic
- Export-based API for external consumption of the Notion client

## Runtime Environment
- Node.js 18+ requirement (specified in package-lock.json)
- Designed specifically for Replit's hosting environment
- Environment variable-based configuration for different deployment contexts

# External Dependencies

## Notion API
- **@notionhq/client** (v5.1.0): Official Notion JavaScript SDK for database and page operations
- Requires OAuth access tokens for authentication
- Used for all Notion workspace interactions

## Replit Connectors
- Replit's internal connector system for OAuth management
- Hostname resolution through `REPLIT_CONNECTORS_HOSTNAME` environment variable
- Token-based authentication with Replit's API endpoints
- Automatic credential refresh and secure storage

## Environment Dependencies
- `REPL_IDENTITY`: Replit identity token for repl environments
- `WEB_REPL_RENEWAL`: Deployment renewal token for web deployments
- `REPLIT_CONNECTORS_HOSTNAME`: Replit connectors API hostname