# WProj

## Prerequisites
- Node.js installed

## Setup Instructions

When cloning this repository on a new machine, you need to install dependencies and configure the Convex database connection.

1. **Install dependencies:**
   ```bash
   npm install
   ```

2. **Set up Convex Backend & Environment Variables:**
   Run the following command. It will prompt you to log in to Convex and select the project. It will automatically create the `.env.local` file for you with the correct database URLs.
   ```bash
   npx convex dev
   ```

3. **Start the Frontend Development Server:**
   Leave the `npx convex dev` command running in its terminal, and open a **second terminal** to start Vite:
   ```bash
   npm run dev
   ```
