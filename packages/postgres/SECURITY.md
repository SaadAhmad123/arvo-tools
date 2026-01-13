# Security Policy

## Reporting a Vulnerability

I take the security of `@arvo-tools/postgres` seriously. If you discover a security vulnerability, please follow these steps:

### How to Report

**Please do not report security vulnerabilities through public GitHub issues.**

Instead, please report security vulnerabilities by reporting them via [Github's private vulnerability reporting](https://github.com/SaadAhmad123/arvo-tools/security/advisories)

Include the following information in your report:

- Type of vulnerability (e.g., SQL injection, credential exposure, etc.)
- Full paths of source file(s) related to the vulnerability
- Location of the affected source code (tag/branch/commit or direct URL)
- Step-by-step instructions to reproduce the issue
- Proof-of-concept or exploit code (if possible)
- Impact of the issue, including how an attacker might exploit it

### What to Expect

- You will receive an acknowledgment of your report within 48-96 hours
- I will investigate and validate the issue within 14 days
- Once validated, I will work on a fix and coordinate disclosure timing with you
- I will credit you in the security advisory (unless you prefer to remain anonymous)

## Security Best Practices

When using `@arvo-tools/postgres`, please follow these security guidelines:

### Database Security

1. **Never commit credentials** - Use environment variables for database connection strings
   ```typescript
   // ✅ Good
   connectionString: process.env.POSTGRES_CONNECTION_STRING

   // ❌ Bad
   connectionString: 'postgresql://user:password@localhost:5432/mydb'
   ```

2. **Use least privilege access** - Grant only necessary database permissions
   - Create dedicated database users for the application
   - Limit permissions to only required tables and operations
   - Use different credentials for development and production

3. **Enable SSL/TLS connections** - Always use encrypted connections in production
   ```typescript
   connectionString: 'postgresql://user:password@host:5432/db?sslmode=require'
   ```

4. **Restrict network access** - Use firewall rules and security groups to limit database access
   - Only allow connections from application servers
   - Use VPCs or private networks when possible

### Application Security

1. **Validate input data** - Ensure all event data is properly validated before processing
   - Use Arvo contracts to enforce type safety
   - Validate data at system boundaries

2. **Handle sensitive data carefully** - Avoid storing sensitive information in workflow state
   - Consider encryption for sensitive data at rest
   - Use domained events for operations requiring external secure systems

3. **Monitor for suspicious activity** - Enable OpenTelemetry tracing to detect anomalies
   ```typescript
   config: {
     enableOtel: true
   }
   ```

4. **Keep dependencies updated** - Regularly update to the latest versions
   ```bash
   pnpm update @arvo-tools/postgres
   ```

### Lock Configuration Security

1. **Set appropriate lock TTLs** - Prevent indefinite locks that could be exploited
   ```typescript
   lockConfig: {
     ttlMs: 120000  // 2 minutes - adjust based on your needs
   }
   ```

2. **Monitor lock table** - Watch for unusual lock patterns that might indicate attacks

### Queue Security

1. **Configure dead letter queues** - Capture and investigate failed jobs
   ```typescript
   queue: {
     deadLetter: 'my_dlq'
   }
   ```

2. **Set job retention limits** - Prevent database bloat
   ```typescript
   worker: {
     retentionSeconds: 604800  // 7 days
   }
   ```

3. **Monitor queue statistics** - Watch for unusual patterns
   ```typescript
   const stats = await broker.getStats();
   ```

## Known Security Considerations

### SQL Injection Protection

This package uses parameterized queries via the `pg` library and `pg-format` for identifier formatting, which protects against SQL injection. HoIver:

- Never construct raw SQL with user input
- Always use the provided APIs for database operations
- Custom table names should be validated before use

### Connection Pool Exhaustion

Attackers might attempt to exhaust your connection pool:

- Set appropriate `max` connection limits
- Configure timeouts to release stale connections
- Monitor pool usage with `pg_stat_activity`

```typescript
config: {
  max: 20,
  connectionTimeoutMillis: 5000,
  idleTimeoutMillis: 30000
}
```

### Event Data Size

Large event payloads could lead to denial of service:

- Implement payload size limits at the application level
- Monitor JSONB column sizes in the state table
- Consider implementing data compression for large payloads

## Disclosure Policy

When I receive a security bug report, I will:

1. Confirm the problem and determine affected versions
2. Audit code to find similar problems
3. Prepare fixes for all supported versions
4. Release new security patch versions as soon as possible
5. Publish a security advisory on GitHub

## Security Updates

Security updates will be released as patch versions (e.g., 1.0.x) and will be clearly marked in the [CHANGELOG](./CHANGELOG.md) with a `[SECURITY]` prefix.

## Acknowledgments

I appreciate the security research community's efforts in responsibly disclosing vulnerabilities. Contributors who report valid security issues will be acknowledged in our security advisories (unless they prefer anonymity).

## License

This security policy is part of the `@arvo-tools/postgres` project and is licensed under the MIT License.
