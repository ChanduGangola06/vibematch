// Runs before every test file: deterministic, safe environment.
process.env.NODE_ENV = 'test';
process.env.JWT_SECRET ??= 'test-only-jwt-secret-0123456789abcdef0123456789';
process.env.MONGODB_URI ??= 'mongodb://127.0.0.1:27017/vibematch-test';
process.env.BCRYPT_COST = '4';
process.env.LOG_LEVEL = 'silent';
process.env.SETTINGS_ENCRYPTION_KEY ??= Buffer.alloc(32, 7).toString('base64');
