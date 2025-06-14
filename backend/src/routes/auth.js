const express = require('express');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const { body, validationResult } = require('express-validator');
const rateLimit = require('express-rate-limit');

const databaseService = require('../services/database');
const redisService = require('../services/redis');
const logger = require('../utils/logger');
const { asyncHandler, ValidationError, UnauthorizedError, ConflictError } = require('../middleware/errorHandler');
const { validateTelegramWebApp, authMiddleware: auth } = require('../middleware/auth');

const router = express.Router();

// Rate limiting for auth routes (temporarily increased for testing)
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 100, // Temporarily increased from 10 to 100 for testing
  message: {
    error: 'Too many authentication attempts, please try again later.',
    code: 'AUTH_RATE_LIMIT'
  },
  standardHeaders: true,
  legacyHeaders: false,
});

// Apply rate limiting to all auth routes
router.use(authLimiter);

// Validation rules
const loginValidation = [
  body('telegramId').isInt({ min: 1 }).withMessage('Valid Telegram ID required'),
  body('username').optional().isLength({ min: 1, max: 50 }).withMessage('Username must be 1-50 characters'),
  body('firstName').optional().isLength({ min: 1, max: 50 }).withMessage('First name must be 1-50 characters'),
  body('lastName').optional().isLength({ min: 1, max: 50 }).withMessage('Last name must be 1-50 characters'),
  body('languageCode').optional().isLength({ min: 2, max: 10 }).withMessage('Invalid language code'),
];

// Helper function to generate JWT tokens
const generateTokens = (userId) => {
  const accessToken = jwt.sign(
    { userId, type: 'access' },
    process.env.JWT_SECRET,
    { expiresIn: process.env.JWT_EXPIRES_IN || '7d' }
  );

  const refreshToken = jwt.sign(
    { userId, type: 'refresh' },
    process.env.JWT_REFRESH_SECRET,
    { expiresIn: process.env.JWT_REFRESH_EXPIRES_IN || '30d' }
  );

  return { accessToken, refreshToken };
};

// Helper function to store token in database
const storeToken = async (userId, token, type = 'access') => {
  const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
  const expiresAt = new Date();
  
  if (type === 'access') {
    expiresAt.setDate(expiresAt.getDate() + 7); // 7 days
  } else {
    expiresAt.setDate(expiresAt.getDate() + 30); // 30 days
  }

  await databaseService.query(
    `INSERT INTO user_tokens (user_id, token_hash, token_type, expires_at) 
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (user_id, token_type) 
     DO UPDATE SET token_hash = $2, expires_at = $4, created_at = NOW()`,
    [userId, tokenHash, type, expiresAt]
  );
};

/**
 * @route POST /api/auth/initialize
 * @desc Initialize user from Telegram WebApp
 * @access Public
 */
router.post('/initialize', 
  loginValidation,
  asyncHandler(async (req, res) => {
    // Validate request
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      throw new ValidationError('Validation failed', errors.array());
    }

    const { telegramId, username, firstName, lastName, languageCode } = req.body;

    // Check if user exists
    let userQuery = `
      SELECT id, telegram_id, username, first_name, last_name, 
             aegt_balance, ton_balance, miner_level, energy_capacity,
             created_at, updated_at, is_active
      FROM users 
      WHERE telegram_id = $1
    `;
    
    let result = await databaseService.query(userQuery, [telegramId]);
    let user;

    if (result.rows.length === 0) {
      // Create new user
      const insertQuery = `
        INSERT INTO users (
          telegram_id, username, first_name, last_name, language_code,
          aegt_balance, ton_balance, miner_level, energy_capacity,
          created_at, updated_at, is_active
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, NOW(), NOW(), true)
        RETURNING id, telegram_id, username, first_name, last_name,
                  aegt_balance, ton_balance, miner_level, energy_capacity,
                  created_at, updated_at, is_active
      `;

      const insertResult = await databaseService.query(insertQuery, [
        telegramId,
        username || null,
        firstName || null,
        lastName || null,
        languageCode || 'en',
        0, // Initial AEGT balance
        0, // Initial TON balance
        1, // Initial miner level
        1000, // Initial energy capacity
      ]);

      user = insertResult.rows[0];

      // Initialize user state in Redis
      await redisService.setUserMiningState(user.id, {
        isActive: false,
        hashrate: 100,
        currentBlock: null,
        blockStartTime: null,
        blocksMined: 0,
        totalRewards: 0
      });

      await redisService.setUserEnergyState(user.id, {
        current: 1000,
        max: 1000,
        lastUpdate: Date.now(),
        regenRate: 250 // per hour
      });

      logger.info('New user created', {
        userId: user.id,
        telegramId,
        username
      });
    } else {
      user = result.rows[0];

      // Update user info if changed
      const updateQuery = `
        UPDATE users 
        SET username = $2, first_name = $3, last_name = $4, 
            language_code = $5, updated_at = NOW(), last_activity = NOW()
        WHERE id = $1
        RETURNING id, telegram_id, username, first_name, last_name,
                  aegt_balance, ton_balance, miner_level, energy_capacity,
                  created_at, updated_at, is_active
      `;

      const updateResult = await databaseService.query(updateQuery, [
        user.id,
        username || user.username,
        firstName || user.first_name,
        lastName || user.last_name,
        languageCode || user.language_code
      ]);

      user = updateResult.rows[0];
    }

    // Check if user is active
    if (!user.is_active) {
      throw new UnauthorizedError('Account is deactivated');
    }

    res.json({
      success: true,
      user: {
        id: user.id,
        telegramId: user.telegram_id,
        username: user.username,
        firstName: user.first_name,
        lastName: user.last_name,
        aegtBalance: user.aegt_balance,
        tonBalance: user.ton_balance,
        minerLevel: user.miner_level,
        energyCapacity: user.energy_capacity,
        createdAt: user.created_at,
        updatedAt: user.updated_at
      }
    });
  })
);

/**
 * @route POST /api/auth/login
 * @desc Login user and generate tokens
 * @access Public
 */
router.post('/login',
  loginValidation,
  asyncHandler(async (req, res) => {
    // Validate request
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      throw new ValidationError('Validation failed', errors.array());
    }

    const { telegramId } = req.body;

    // Get user
    const userQuery = `
      SELECT id, telegram_id, username, first_name, last_name,
             aegt_balance, ton_balance, miner_level, energy_capacity,
             created_at, updated_at, is_active
      FROM users 
      WHERE telegram_id = $1 AND is_active = true
    `;
    
    const result = await databaseService.query(userQuery, [telegramId]);
    
    if (result.rows.length === 0) {
      throw new UnauthorizedError('User not found or inactive');
    }

    const user = result.rows[0];

    // Generate tokens
    const { accessToken, refreshToken } = generateTokens(user.id);

    // Store tokens in database
    await storeToken(user.id, accessToken, 'access');
    await storeToken(user.id, refreshToken, 'refresh');

    // Update last activity
    await databaseService.query(
      'UPDATE users SET last_activity = NOW() WHERE id = $1',
      [user.id]
    );

    logger.info('User logged in', {
      userId: user.id,
      telegramId: user.telegram_id,
      ip: req.ip
    });

    res.json({
      success: true,
      user: {
        id: user.id,
        telegramId: user.telegram_id,
        username: user.username,
        firstName: user.first_name,
        lastName: user.last_name,
        aegtBalance: user.aegt_balance,
        tonBalance: user.ton_balance,
        minerLevel: user.miner_level,
        energyCapacity: user.energy_capacity,
        createdAt: user.created_at,
        updatedAt: user.updated_at
      },
      token: accessToken,
      refreshToken
    });
  })
);

/**
 * @route POST /api/auth/refresh
 * @desc Refresh access token
 * @access Public
 */
router.post('/refresh',
  body('refreshToken').notEmpty().withMessage('Refresh token required'),
  asyncHandler(async (req, res) => {
    // Validate request
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      throw new ValidationError('Validation failed', errors.array());
    }

    const { refreshToken } = req.body;

    try {
      // Verify refresh token
      const decoded = jwt.verify(refreshToken, process.env.JWT_REFRESH_SECRET);
      
      if (decoded.type !== 'refresh') {
        throw new UnauthorizedError('Invalid token type');
      }

      // Check if refresh token exists in database
      const tokenHash = crypto.createHash('sha256').update(refreshToken).digest('hex');
      const tokenQuery = `
        SELECT user_id FROM user_tokens 
        WHERE user_id = $1 AND token_hash = $2 AND token_type = 'refresh' 
        AND expires_at > NOW()
      `;
      
      const tokenResult = await databaseService.query(tokenQuery, [decoded.userId, tokenHash]);
      
      if (tokenResult.rows.length === 0) {
        throw new UnauthorizedError('Invalid or expired refresh token');
      }

      // Get user
      const userQuery = `
        SELECT id, telegram_id, username, first_name, last_name,
               aegt_balance, ton_balance, miner_level, energy_capacity,
               created_at, updated_at, is_active
        FROM users 
        WHERE id = $1 AND is_active = true
      `;
      
      const userResult = await databaseService.query(userQuery, [decoded.userId]);
      
      if (userResult.rows.length === 0) {
        throw new UnauthorizedError('User not found or inactive');
      }

      const user = userResult.rows[0];

      // Generate new access token
      const { accessToken } = generateTokens(user.id);

      // Store new access token
      await storeToken(user.id, accessToken, 'access');

      logger.info('Token refreshed', {
        userId: user.id,
        ip: req.ip
      });

      res.json({
        success: true,
        token: accessToken,
        user: {
          id: user.id,
          telegramId: user.telegram_id,
          username: user.username,
          firstName: user.first_name,
          lastName: user.last_name,
          aegtBalance: user.aegt_balance,
          tonBalance: user.ton_balance,
          minerLevel: user.miner_level,
          energyCapacity: user.energy_capacity,
          createdAt: user.created_at,
          updatedAt: user.updated_at
        }
      });

    } catch (error) {
      if (error.name === 'JsonWebTokenError' || error.name === 'TokenExpiredError') {
        throw new UnauthorizedError('Invalid or expired refresh token');
      }
      throw error;
    }
  })
);

/**
 * @route GET /api/auth/me
 * @desc Get current user info
 * @access Private
 */
router.get('/me', authMiddleware, asyncHandler(async (req, res) => {
  res.json({
    success: true,
    user: req.user
  });
}));

/**
 * @route POST /api/auth/logout
 * @desc Logout user and invalidate tokens
 * @access Private
 */
router.post('/logout', authMiddleware, asyncHandler(async (req, res) => {
  // Delete user tokens
  await databaseService.query(
    'DELETE FROM user_tokens WHERE user_id = $1',
    [req.user.id]
  );

  // Clear user cache
  await redisService.flushUserData(req.user.id);

  logger.info('User logged out', {
    userId: req.user.id,
    ip: req.ip
  });

  res.json({
    success: true,
    message: 'Logged out successfully'
  });
}));

/**
 * @route POST /api/auth/logout-all
 * @desc Logout from all devices
 * @access Private
 */
router.post('/logout-all', authMiddleware, asyncHandler(async (req, res) => {
  // Delete all user tokens
  await databaseService.query(
    'DELETE FROM user_tokens WHERE user_id = $1',
    [req.user.id]
  );

  // Clear user cache
  await redisService.flushUserData(req.user.id);

  logger.info('User logged out from all devices', {
    userId: req.user.id,
    ip: req.ip
  });

  res.json({
    success: true,
    message: 'Logged out from all devices successfully'
  });
}));

/**
 * @route POST /api/auth/wallet/challenge
 * @desc Generate challenge for TON wallet authentication
 * @access Public
 */
router.post('/wallet/challenge',
  [
    body('walletAddress')
      .isLength({ min: 48, max: 48 })
      .withMessage('Invalid TON wallet address format')
  ],
  asyncHandler(async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      throw new ValidationError('Validation failed', errors.array());
    }

    const { walletAddress } = req.body;
    
    // Generate random challenge
    const challenge = crypto.randomBytes(32).toString('hex');
    const expiresAt = new Date(Date.now() + 5 * 60 * 1000); // 5 minutes

    // Store challenge in database
    await databaseService.query(`
      INSERT INTO wallet_auth_sessions (wallet_address, challenge, expires_at)
      VALUES ($1, $2, $3)
    `, [walletAddress, challenge, expiresAt]);

    res.json({
      success: true,
      challenge,
      expiresAt
    });
  })
);

/**
 * @route POST /api/auth/wallet/verify
 * @desc Verify TON wallet signature and login/register user
 * @access Public
 */
router.post('/wallet/verify',
  [
    body('walletAddress')
      .isLength({ min: 48, max: 48 })
      .withMessage('Invalid TON wallet address format'),
    body('signature')
      .isLength({ min: 1 })
      .withMessage('Signature is required'),
    body('challenge')
      .isLength({ min: 1 })
      .withMessage('Challenge is required')
  ],
  asyncHandler(async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      throw new ValidationError('Validation failed', errors.array());
    }

    const { walletAddress, signature, challenge } = req.body;

    // Verify challenge exists and is not expired
    const challengeQuery = `
      SELECT id FROM wallet_auth_sessions 
      WHERE wallet_address = $1 AND challenge = $2 
      AND expires_at > NOW() AND used = false
    `;
    
    const challengeResult = await databaseService.query(challengeQuery, [walletAddress, challenge]);
    
    if (challengeResult.rows.length === 0) {
      throw new UnauthorizedError('Invalid or expired challenge');
    }

    // Mark challenge as used
    await databaseService.query(`
      UPDATE wallet_auth_sessions 
      SET used = true 
      WHERE wallet_address = $1 AND challenge = $2
    `, [walletAddress, challenge]);

    // TODO: Verify TON signature (implement TON signature verification)
    // For now, we'll trust the frontend verification
    
    // Check if user exists with this wallet
    let userQuery = `
      SELECT id, telegram_id, username, first_name, last_name,
             aegt_balance, ton_balance, miner_level, energy_capacity,
             created_at, updated_at, is_active, ton_wallet_address
      FROM users 
      WHERE ton_wallet_address = $1 AND is_active = true
    `;
    
    let userResult = await databaseService.query(userQuery, [walletAddress]);
    let user;

    if (userResult.rows.length === 0) {
      // Create new user with wallet
      const insertQuery = `
        INSERT INTO users (
          telegram_id, username, first_name, ton_wallet_address, 
          wallet_connected_at, login_method, aegt_balance, ton_balance, 
          miner_level, energy_capacity
        ) VALUES ($1, $2, $3, $4, NOW(), 'wallet', 0, 0, 1, 1000)
        RETURNING id, telegram_id, username, first_name, last_name,
                  aegt_balance, ton_balance, miner_level, energy_capacity,
                  created_at, updated_at, ton_wallet_address
      `;
      
      // Generate a unique telegram_id for wallet users (negative number)
      const walletTelegramId = -Math.abs(walletAddress.slice(-10).split('').reduce((a, b) => a + b.charCodeAt(0), 0));
      const username = `wallet_${walletAddress.slice(-8)}`;
      const firstName = `Wallet User`;

      const insertResult = await databaseService.query(insertQuery, [
        walletTelegramId,
        username,
        firstName,
        walletAddress
      ]);

      user = insertResult.rows[0];

      // Initialize user energy state
      await redisService.setUserEnergyState(user.id, {
        current: 1000,
        max: 1000,
        lastUpdate: Date.now(),
        regenRate: 250
      });

      logger.info('New wallet user created', {
        userId: user.id,
        walletAddress,
        username
      });
    } else {
      user = userResult.rows[0];
      
      // Update last activity
      await databaseService.query(`
        UPDATE users 
        SET last_activity = NOW(), updated_at = NOW()
        WHERE id = $1
      `, [user.id]);
    }

    // Generate tokens
    const accessToken = jwt.sign(
      { userId: user.id, type: 'access' },
      process.env.JWT_SECRET,
      { expiresIn: process.env.JWT_ACCESS_EXPIRES_IN || '15m' }
    );

    const refreshToken = jwt.sign(
      { userId: user.id, type: 'refresh' },
      process.env.JWT_SECRET,
      { expiresIn: process.env.JWT_REFRESH_EXPIRES_IN || '7d' }
    );

    // Store refresh token
    const tokenHash = crypto.createHash('sha256').update(refreshToken).digest('hex');
    const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000); // 7 days

    await databaseService.query(`
      INSERT INTO user_tokens (user_id, token_hash, token_type, expires_at)
      VALUES ($1, $2, 'refresh', $3)
      ON CONFLICT (user_id, token_type) 
      DO UPDATE SET token_hash = $2, expires_at = $3, created_at = NOW()
    `, [user.id, tokenHash, expiresAt]);

    res.json({
      success: true,
      user: {
        id: user.id,
        telegramId: user.telegram_id,
        username: user.username,
        firstName: user.first_name,
        lastName: user.last_name,
        aegtBalance: user.aegt_balance,
        tonBalance: user.ton_balance,
        minerLevel: user.miner_level,
        energyCapacity: user.energy_capacity,
        tonWalletAddress: user.ton_wallet_address,
        createdAt: user.created_at,
        updatedAt: user.updated_at
      },
      token: accessToken,
      refreshToken
    });
  })
);

/**
 * @route POST /api/auth/wallet/connect
 * @desc Connect TON wallet to existing Telegram user
 * @access Private
 */
router.post('/wallet/connect',
  auth,
  [
    body('walletAddress')
      .isLength({ min: 48, max: 48 })
      .withMessage('Invalid TON wallet address format'),
    body('signature')
      .isLength({ min: 1 })
      .withMessage('Signature is required'),
    body('challenge')
      .isLength({ min: 1 })
      .withMessage('Challenge is required')
  ],
  asyncHandler(async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      throw new ValidationError('Validation failed', errors.array());
    }

    const { walletAddress, signature, challenge } = req.body;
    const userId = req.user.id;

    // Verify challenge
    const challengeQuery = `
      SELECT id FROM wallet_auth_sessions 
      WHERE wallet_address = $1 AND challenge = $2 
      AND expires_at > NOW() AND used = false
    `;
    
    const challengeResult = await databaseService.query(challengeQuery, [walletAddress, challenge]);
    
    if (challengeResult.rows.length === 0) {
      throw new UnauthorizedError('Invalid or expired challenge');
    }

    // Check if wallet is already connected to another user
    const existingWalletQuery = `
      SELECT id FROM users 
      WHERE ton_wallet_address = $1 AND id != $2 AND is_active = true
    `;
    
    const existingResult = await databaseService.query(existingWalletQuery, [walletAddress, userId]);
    
    if (existingResult.rows.length > 0) {
      throw new ConflictError('This wallet is already connected to another account');
    }

    // Mark challenge as used
    await databaseService.query(`
      UPDATE wallet_auth_sessions 
      SET used = true 
      WHERE wallet_address = $1 AND challenge = $2
    `, [walletAddress, challenge]);

    // Connect wallet to user
    await databaseService.query(`
      UPDATE users 
      SET ton_wallet_address = $1, wallet_connected_at = NOW(), updated_at = NOW()
      WHERE id = $2
    `, [walletAddress, userId]);

    logger.info('Wallet connected to user', {
      userId,
      walletAddress
    });

    res.json({
      success: true,
      message: 'Wallet connected successfully',
      walletAddress
    });
  })
);

module.exports = router;