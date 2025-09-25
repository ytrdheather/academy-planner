# Overview

This is a comprehensive student learning planner web application designed for Vercel deployment. The system features a multi-user teacher dashboard with role-based access control, full Notion database integration, and JWT-based authentication optimized for serverless environments. Students can log daily study progress including test results, homework verification, and reading activities, while teachers can monitor progress through filtered dashboards based on their assigned responsibilities.

# User Preferences

Preferred communication style: Simple, everyday language.

# System Architecture

## Vercel Serverless Structure
The application is optimized for Vercel's serverless platform:
- `api/index.js` - Main Express app exported as serverless function
- `public/views/` - Static HTML files served directly
- `vercel.json` - Routing configuration for serverless deployment
- JWT-based authentication replacing memory sessions for serverless compatibility

## Multi-User Authentication System
Implements role-based access control with 7 distinct user accounts:
- **Manager (1)**: Full system access and student management
- **Teachers (4)**: Access to assigned students only
- **Assistants (2)**: Limited read-only permissions
- JWT tokens stored in localStorage with automatic expiration handling
- Session regeneration on login for security

## Permission System
- **Manager**: All students + administrative functions
- **Teacher**: Assigned students + progress management
- **Assistant**: Limited viewing capabilities
- Server-side filtering based on user roles and assignments
- Activity logging for accountability

## Database Integration
- Notion API integration for student data and progress tracking
- Graceful fallback to sample data when Notion is unavailable
- Support for both Replit connector authentication and direct API keys
- Smart book title autocomplete for English and Korean reading lists

## Security Features
- Environment variable validation for production deployments
- JWT secret requirement in production environments
- Protection against session fixation attacks
- Secure token storage and automatic cleanup on logout

## Deployment Architecture
- **Primary Target**: Vercel serverless platform
- **Development**: Replit environment with full debugging
- **Runtime**: Node.js 18+ with ES6 modules
- **Authentication**: JWT-based for serverless compatibility
- **Static Assets**: Served directly by Vercel CDN

## Environment Configuration
- `JWT_SECRET`: Required for production token signing
- `STUDENT_DATABASE_ID` & `PROGRESS_DATABASE_ID`: Notion database connections
- `REPLIT_CONNECTORS_HOSTNAME`: For Replit-based Notion authentication
- Automatic fallback to sample data for development testing

# External Dependencies

## Notion API
- **@notionhq/client** (v5.1.0): Official Notion JavaScript SDK for database and page operations
- Requires OAuth access tokens for authentication
- Used for all Notion workspace interactions

## JWT Authentication
- **jsonwebtoken** (v9.0.2): JWT token generation and verification
- Stateless authentication suitable for serverless environments
- 24-hour token expiration with automatic refresh

## Replit Connectors (Development Only)
- Replit's internal connector system for OAuth management
- Hostname resolution through `REPLIT_CONNECTORS_HOSTNAME` environment variable
- Token-based authentication with Replit's API endpoints
- Automatic credential refresh and secure storage

## Vercel Environment Variables
Required for production deployment:
- `JWT_SECRET`: Strong random string for token signing (REQUIRED)
- `NOTION_ACCESS_TOKEN`: Notion integration token from https://www.notion.so/my-integrations (REQUIRED)
- `NODE_ENV`: Set to 'production' for deployment
- `STUDENT_DATABASE_ID`: Notion student database ID (optional - uses sample data if missing)
- `PROGRESS_DATABASE_ID`: Notion progress database ID (optional - uses sample data if missing)

# User Accounts

## Login Credentials (All use same password: rdtd112!@)
- `manager` - 매니저 (전체 관리)
- `teacher1` - 선생님1 (담당 학생)
- `teacher2` - 선생님2 (담당 학생)  
- `teacher3` - 선생님3 (담당 학생)
- `teacher4` - 선생님4 (담당 학생)
- `assistant1` - 아르바이트1 (제한적 권한)
- `assistant2` - 아르바이트2 (제한적 권한)

# Deployment Guide

## Vercel Deployment Steps
1. **Create Notion Integration**:
   - Go to https://www.notion.so/my-integrations
   - Create new integration and copy the token
   - Share your Notion databases with the integration

2. **Connect GitHub repository to Vercel**

3. **Set environment variables in Vercel dashboard**:
   - `JWT_SECRET`: Generate strong random string (use openssl rand -base64 32)
   - `NOTION_ACCESS_TOKEN`: Your Notion integration token
   - `NODE_ENV`: production
   - Optional: `STUDENT_DATABASE_ID` and `PROGRESS_DATABASE_ID`

4. **Deploy with zero configuration** (vercel.json handles routing)

5. **Access deployed application** at Vercel provided URL

**Note**: The app works with or without Notion databases - it uses sample data for testing when databases are not configured.

## Local Development
- Runs on port 5000 in Replit environment
- Automatic Notion connection testing
- JWT tokens work with development fallback
- All static files served properly