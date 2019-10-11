const compression = require('compression');
const config = require('config');
const express = require('express');
const log = require('npmlog');
const morgan = require('morgan');
const Problem = require('api-problem');

const keycloak = require('./src/components/keycloak');
const utils = require('./src/components/utils');
const v1Router = require('./src/routes/v1');

const { DataConnectionFactory } = require('./src/services/data/connection');
const { DataServiceFactory } = require('./src/services/data/service');
const { QueueConnectionFactory } = require('./src/services/queue/connection');
const { QueueServiceFactory, QueueListener } = require('./src/services/queue/service');
const { EmailConnectionFactory } = require('./src/services/email/connection');
const { EmailServiceFactory } = require('./src/services/email/service');

const apiRouter = express.Router();
const state = {
  isRedisConnected: false,
  isShutdown: false
};

const app = express();
app.use(compression());
app.use(express.json({
  limit: config.get('server.bodyLimit')
}));
app.use(express.urlencoded({
  extended: false
}));

// Logging Setup
log.level = config.get('server.logLevel');
log.addLevel('debug', 1500, {
  fg: 'cyan'
});

// Print out configuration settings in verbose startup
log.debug('Config', utils.prettyStringify(config));

// Skip if running tests
if (process.env.NODE_ENV !== 'test') {
  // Add Morgan endpoint logging
  app.use(morgan(config.get('server.morganFormat')));
  
  (
    async () => {
      let dataConnectionOk = false;
      let queueConnectionOk = false;
      let emailConnectionOk = false;
      
      let dataService = undefined;
      let queueService = undefined;
      let emailService = undefined;
      
      try {
        const dataConnection = DataConnectionFactory.getConnection();
        dataConnectionOk = await dataConnection.initialize();
        if (dataConnectionOk) {
          dataService = DataServiceFactory.initialize(dataConnection);
        }
      } catch (err) {
        log.error(`Error initializing database: ${err.message}`);
      }
      try {
        const emailConnection = EmailConnectionFactory.getSmtpConnection();
        // skip verification await emailConnection.verify();
        //... queue will fail and log if smtp times out...
        emailConnectionOk = true;
        if (emailConnectionOk) {
          emailService = EmailServiceFactory.initialize(emailConnection);
        }
      } catch (err) {
        log.error(`Error initializing email: ${err.message}`);
      }
      try {
        const queueConnection = QueueConnectionFactory.getConnection();
        queueConnectionOk = await queueConnection.initialize();
        if (queueConnectionOk && dataService && emailService) {
          queueService = QueueServiceFactory.initialize(queueConnection, dataService, emailService);
          
          queueConnection.queue().process(QueueListener.onProcess);
          queueConnection.queue().on('completed', QueueListener.onCompleted);
          queueConnection.queue().on('error', QueueListener.onError);
          queueConnection.queue().on('failed', QueueListener.onFailed);
        }
      } catch (err) {
        log.error(`Error initializing queue: ${err.message}`);
      }
      if (!dataConnectionOk || !dataService || !queueConnectionOk || !queueService || !emailConnectionOk || !emailService) {
        log.error(`Error initializing infrastructure: dataConnectionOk = ${dataConnectionOk}, dataService = ${dataService !== undefined}, queueConnectionOk = ${queueConnectionOk}, queueService = ${queueService !== undefined}, emailConnectionOk = ${queueConnectionOk}, emailService = ${queueService !== undefined}  `);
        shutdown();
      }
      
    }
  )();
}

// Use Keycloak OIDC Middleware
app.use(keycloak.middleware());

// GetOK Base API Directory
apiRouter.get('/', (_req, res) => {
  if (state.isShutdown) {
    throw new Error('Server shutting down');
  } else if (!state.isRedisConnected) {
    throw new Error('Server not connected to Redis');
  } else {
    res.status(200).json({
      endpoints: [
        '/api/v1'
      ],
      versions: [
        1
      ]
    });
  }
});

// v1 Router
apiRouter.use('/v1', v1Router);

// Root level Router
app.use(/(\/api)?/, apiRouter);

// Handle 500
// eslint-disable-next-line no-unused-vars
app.use((err, _req, res, _next) => {
  if (err.stack) {
    log.error(err.stack);
  }
  
  if (err instanceof Problem) {
    err.send(res);
  } else {
    new Problem(500, {
      details: (err.message) ? err.message : err
    }).send(res);
  }
});

// Handle 404
app.use((_req, res) => {
  new Problem(404).send(res);
});

// Prevent unhandled errors from crashing application
process.on('unhandledRejection', err => {
  if (err && err.stack) {
    log.error(err.stack);
  }
});

// Graceful shutdown support
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

function shutdown () {
  log.info('Received kill signal. Shutting down...');
  state.isShutdown = true;
  QueueConnectionFactory.close();
  // Wait 3 seconds before hard exiting
  setTimeout(() => process.exit(), 3000);
}

module.exports = app;
