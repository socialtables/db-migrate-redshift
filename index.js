var util = require('util');
var pg = require('pg');
var semver = require('semver');
var Base = require('db-migrate-base');
var type;
var log;
var Promise = require('bluebird');

var internals = {};

var PgDriver = Base.extend({
    init: function(connection, schema, intern) {
        this._escapeString = '\'';
        this._super(intern);
        this.internals = intern;
        this.connection = connection;
        this.schema = schema || "public";
        this.connection.connect();
    },

    startMigration: function(cb){

      if(!this.internals.notransactions) {

        return this.runSql('BEGIN;').nodeify(cb);
      }
      else
        return Promise.resolve().nodeify(cb);
    },

    endMigration: function(cb){

      if(!this.internals.notransactions) {

        return this.runSql('COMMIT;').nodeify(cb);
      }
      else
        return Promise.resolve(null).nodeify(cb);
    },

    createColumnDef: function(name, spec, options, tableName) {
        var type = spec.autoIncrement ? '' : this.mapDataType(spec.type);
        var len = spec.length ? util.format('(%s)', spec.length) : '';
        var constraint = this.createColumnConstraint(spec, options, tableName, name);
        if (name.charAt(0) != '"') {
            name = '"' + name + '"';
        }

        return { foreignKey: constraint.foreignKey,
                 constraints: [name, type, len, constraint.constraints].join(' ') };
    },

    createTable: function(tableName, options, callback) {
        log.verbose('creating table:', tableName);
        var columnSpecs = options;
        var tableOptions = {};

        if (options.columns !== undefined) {
          columnSpecs = options.columns;
          delete options.columns;
          tableOptions = options;
        }

        var ifNotExistsSql = "";
        if(tableOptions.ifNotExists) {
          ifNotExistsSql = "IF NOT EXISTS";
        }

        var primaryKeyColumns = [];
        var columnDefOptions = {
          emitPrimaryKey: false
        };

        for (var columnName in columnSpecs) {
          var columnSpec = this.normalizeColumnSpec(columnSpecs[columnName]);
          columnSpecs[columnName] = columnSpec;
          if (columnSpec.primaryKey) {
            primaryKeyColumns.push(columnName);
          }
        }

        var pkSql = '';
        if (primaryKeyColumns.length > 1) {
          pkSql = util.format(', PRIMARY KEY (%s)',
            this.quoteDDLArr(primaryKeyColumns).join(', '));

        } else {
          columnDefOptions.emitPrimaryKey = true;
        }

        var columnDefs = [];
        var foreignKeys = [];
        var sortKeys = [];
        var sortKeyType = type.SORTKEY_COMPOUND;
        for (var columnName in columnSpecs) {
          var columnSpec = columnSpecs[columnName];
          var constraint = this.createColumnDef(columnName, columnSpec, columnDefOptions, tableName);
          if (columnSpec.sortKey) {
              if (columnSpec.sortKey === type.SORTKEY_INTERLEAVED) {
                  sortKeyType = type.SORTKEY_INTERLEAVED;
              }
              sortKeys.push(columnName);
          }
          columnDefs.push(constraint.constraints);
          if (constraint.foreignKey)
            foreignKeys.push(constraint.foreignKey);
        }

        var sortKeySql = "";
        if (sortKeys.length) {
            sortKeySql = sortKeyType + " sortkey(" + sortKeys.join(", ") + ")";
        }

        var sql = util.format('CREATE TABLE %s %s (%s%s) %s', ifNotExistsSql,
          this.escapeDDL(tableName), columnDefs.join(', '), pkSql, sortKeySql);

        return this.runSql(sql)
        .then(function()
        {
            return this.recurseCallbackArray(foreignKeys);
        }.bind(this)).nodeify(callback);
    },

    mapDataType: function(str) {
        switch(str) {
          case type.STRING:
            return 'VARCHAR';
          case type.DATE_TIME:
            return 'TIMESTAMP';
          case type.BLOB:
            return 'BYTEA';
          case type.SORTKEY_COMPOUND:
            return 'compound';
          case type.SORTKEY_INTERLEAVED:
            return 'interleaved'
        }
        return this._super(str);
    },

    createDatabase: function(dbName, options, callback) {

      var spec = '';

      if(typeof(options) === 'function')
        callback = options;

      this.runSql(util.format('CREATE DATABASE %s %s', this.escapeDDL(dbName),
        spec), callback);
    },

    dropDatabase: function(dbName, options, callback) {

      var ifExists = '';

      if(typeof(options) === 'function')
        callback = options;
      else
      {
        ifExists = (options.ifExists === true) ? 'IF EXISTS' : '';
      }

      this.runSql(util.format('DROP DATABASE %s %s', ifExists, this.escapeDDL(dbName)), callback);
    },

    createSequence: function(sqName, options, callback) {

      var spec = '',
          temp = '';

      if(typeof(options) === 'function')
        callback = options;
      else
      {
        temp = (options.temp === true) ? 'TEMP' : '';
      }

      this.runSql(util.format('CREATE %s SEQUENCE `%s` %s', temp, sqName, spec), callback);
    },

    switchDatabase: function(options, callback) {

      if(typeof(options) === 'object')
      {
        if(typeof(options.database) === 'string')
        {
          log.info('Ignore database option, not available with postgres. Use schema instead!');
          this.runSql(util.format('SET search_path TO `%s`', options.database), callback);
        }
      }
      else if(typeof(options) === 'string')
      {
        this.runSql(util.format('SET search_path TO `%s`', options), callback);
      }
      else
        callback(null);
    },

    dropSequence: function(dbName, options, callback) {

      var ifExists = '',
          rule = '';

      if(typeof(options) === 'function')
        callback = options;
      else
      {
        ifExists = (options.ifExists === true) ? 'IF EXISTS' : '';

        if(options.cascade === true)
          rule = 'CASCADE';
        else if(options.restrict === true)
          rule = 'RESTRICT';
      }

      this.runSql(util.format('DROP SEQUENCE %s `%s` %s', ifExists, dbName, rule), callback);
    },

    createMigrationsTable: function(callback) {
      var options = {
        columns: {
          'id': { type: type.INTEGER, notNull: true, primaryKey: true, autoIncrement: true },
          'name': { type: type.STRING, length: 255, notNull: true},
          'run_on': { type: type.DATE_TIME, notNull: true}
        },
        ifNotExists: false
      };

      return this.all('select version() as version')
      .then(function(result) {

        if (result && result && result.length > 0 && result[0].version) {
          var version = result[0].version;
          var match = version.match(/\d+\.\d+\.\d+/);
          if (match && match[0] && semver.gte(match[0], '9.1.0')) {
            options.ifNotExists = true;
          }
        }

        // Get the current search path so we can change the current schema
        // if necessary
        return this.all("SHOW search_path");
      }.bind(this))
      .then(function(result) {

          var searchPath,
              search_pathes = result[0].search_path.split(',');

          for (var i = 0; i < search_pathes.length; ++i) {
            if (search_pathes[i].indexOf('"') !== 0) {
              search_pathes[i] = '"' + search_pathes[i].trim() + '"';
            }
          }

          result[0].search_path = search_pathes.join(',');

          // if the user specified a different schema, prepend it to the
          // search path. This will make all DDL/DML/SQL operate on the specified
          // schema.
          if (this.schema === 'public') {
              searchPath = result[0].search_path;
          } else {
              searchPath = '"' + this.schema + '",' + result[0].search_path;
          }

          return this.all('SET search_path TO ' + searchPath);
        }.bind(this))
        .then(function() {

          return this.all("SELECT table_name FROM information_schema.tables WHERE table_name = '" +
            this.internals.migrationTable + "'" +
            ((this.schema) ?
              " AND table_schema = '" + this.schema + "'" :
              ''));
        }.bind(this))
        .then(function(result) {

          if (result && result && result.length < 1) {
            return this.createTable(this.internals.migrationTable, options);
          } else {
            return Promise.resolve();
          }
        }.bind(this)).nodeify(callback);
    },

    createSeedsTable: function(callback) {
      var options = {
        columns: {
          'id': { type: type.INTEGER, notNull: true, primaryKey: true, autoIncrement: true },
          'name': { type: type.STRING, length: 255, notNull: true},
          'run_on': { type: type.DATE_TIME, notNull: true}
        },
        ifNotExists: false
      };

      return this.all('select version() as version')
      .then(function(result) {

        if (result && result && result.length > 0 && result[0].version) {
          var version = result[0].version;
          var match = version.match(/\d+\.\d+\.\d+/);
          if (match && match[0] && semver.gte(match[0], '9.1.0')) {
            options.ifNotExists = true;
          }
        }

        // Get the current search path so we can change the current schema
        // if necessary
        return this.all("SHOW search_path");
      }.bind(this))
      .then(function(result) {

          var searchPath;

            // if the user specified a different schema, prepend it to the
            // search path. This will make all DDL/DML/SQL operate on the specified
            // schema.
            if (this.schema === 'public') {
                searchPath = result[0].search_path;
            } else {
                searchPath = '"' + this.schema + '",' + result[0].search_path;
            }

          return this.all('SET search_path TO ' + searchPath);
        }.bind(this))
        .then(function() {

            return this.all("SELECT table_name FROM information_schema.tables WHERE table_name = '" +
              this.internals.seedTable + "'" +
              ((this.schema) ?
                " AND table_schema = '" + this.schema + "'" :
                ''));
        }.bind(this))
        .then(function(result) {

          if (result && result && result.length < 1) {
            return this.createTable(this.internals.seedTable, options);
          } else {
            return Promise.resolve();
          }
        }.bind(this)).nodeify(callback);
    },

    createColumnConstraint: function(spec, options, tableName, columnName) {
        var constraint = [],
            cb;

        if (spec.primaryKey && options.emitPrimaryKey) {
            if (spec.autoIncrement) {
                constraint.push('INT IDENTITY(1,1)');
            }
            constraint.push('PRIMARY KEY');
        }

        if (spec.notNull === true) {
            constraint.push('NOT NULL');
        }

        if (spec.unique) {
            constraint.push('UNIQUE');
        }

        if (spec.defaultValue !== undefined) {
            constraint.push('DEFAULT');
            if (typeof spec.defaultValue == 'string'){
                constraint.push("'" + spec.defaultValue + "'");
            } else {
              constraint.push(spec.defaultValue);
            }
        }

        if (spec.foreignKey) {

          cb = this.bindForeignKey(tableName, columnName, spec.foreignKey);
        }

        return { foreignKey: cb, constraints: constraint.join(' ') };
    },

    renameTable: function(tableName, newTableName, callback) {
        var sql = util.format('ALTER TABLE "%s" RENAME TO "%s"', tableName, newTableName);
        return this.runSql(sql).nodeify(callback);
    },

    removeColumn: function(tableName, columnName, callback) {
        var sql = util.format('ALTER TABLE "%s" DROP COLUMN "%s"', tableName, columnName);

        return this.runSql(sql).nodeify(callback);
    },

    renameColumn: function(tableName, oldColumnName, newColumnName, callback) {
        var sql = util.format('ALTER TABLE "%s" RENAME COLUMN "%s" TO "%s"', tableName, oldColumnName, newColumnName);
        return this.runSql(sql).nodeify(callback);
    },

    changeColumn: function(tableName, columnName, columnSpec, callback) {
      return setNotNull.call(this);

      function setNotNull() {
        var setOrDrop = columnSpec.notNull === true ? 'SET' : 'DROP';
        var sql = util.format('ALTER TABLE "%s" ALTER COLUMN "%s" %s NOT NULL', tableName, columnName, setOrDrop);

        return this.runSql(sql).nodeify(setUnique.bind(this));
      }

      function setUnique(err) {
        if (err) {
          return Promise.reject(err);
        }

        var sql;
        var constraintName = tableName + '_' + columnName + '_key';

        if (columnSpec.unique === true) {
          sql = util.format('ALTER TABLE "%s" ADD CONSTRAINT "%s" UNIQUE ("%s")', tableName, constraintName, columnName);
          return this.runSql(sql).nodeify(setDefaultValue.bind(this));
        } else if (columnSpec.unique === false) {
          sql = util.format('ALTER TABLE "%s" DROP CONSTRAINT "%s"', tableName, constraintName);
          return this.runSql(sql).nodeify(setDefaultValue.bind(this));
        } else {
          return setDefaultValue.call(this);
        }
      }

      function setDefaultValue(err) {
        if (err) {
          return Promise.reject(err).nodeify(callback);
        }

        var sql;

        if (columnSpec.defaultValue !== undefined) {
          var defaultValue = null;
          if (typeof columnSpec.defaultValue == 'string'){
            defaultValue = "'" + columnSpec.defaultValue + "'";
          } else {
            defaultValue = columnSpec.defaultValue;
          }
          sql = util.format('ALTER TABLE "%s" ALTER COLUMN "%s" SET DEFAULT %s', tableName, columnName, defaultValue);
        } else {
          sql = util.format('ALTER TABLE "%s" ALTER COLUMN "%s" DROP DEFAULT', tableName, columnName);
        }
        return this.runSql(sql).then(
          setType.bind(this)
        ).nodeify(callback);
      }

      function setType() {
        if (columnSpec.type !== undefined){
          var using = columnSpec.using !== undefined ?
            columnSpec.using : util.format('USING "%s"::%s', columnName, this.mapDataType(columnSpec.type))
          var sql = util.format('ALTER TABLE "%s" ALTER COLUMN "%s" TYPE %s %s', tableName, columnName, this.mapDataType(columnSpec.type), using);
          return this.runSql(sql);
        }
      }
    },

    addForeignKey: function(tableName, referencedTableName, keyName, fieldMapping, rules, callback) {
      if(arguments.length === 5 && typeof(rules) === 'function') {
        callback = rules;
        rules = {};
      }
      var columns = Object.keys(fieldMapping);
      var referencedColumns = columns.map(function (key) { return '"' + fieldMapping[key] + '"'; });
      var sql = util.format('ALTER TABLE "%s" ADD CONSTRAINT "%s" FOREIGN KEY (%s) REFERENCES "%s" (%s) ON DELETE %s ON UPDATE %s',
        tableName, keyName, this.quoteDDLArr(columns), referencedTableName, referencedColumns, rules.onDelete || 'NO ACTION', rules.onUpdate || 'NO ACTION');
      return this.runSql(sql).nodeify(callback);
    },

    removeForeignKey: function(tableName, keyName, callback) {
      var sql = util.format('ALTER TABLE "%s" DROP CONSTRAINT "%s"', tableName, keyName);
      return this.runSql(sql).nodeify(callback);
    },

    insert: function() {

      var index = 1;

      if( arguments.length > 3 ) {

        index = 2;
      }

      arguments[index] = arguments[index].map(function(value) {
        return 'string' === typeof value ? value : JSON.stringify(value);
      });

      return this._super.apply(this, arguments);
    },

    runSql: function() {
        var callback,
            minLength = 1;

        if(typeof(arguments[arguments.length - 1]) === 'function')
        {
          minLength = 2;
          callback = arguments[arguments.length - 1];
        }

        params = arguments;
        if (params.length > minLength){
            // We have parameters, but db-migrate uses "?" for param substitutions.
            // PG uses "$1", "$2", etc so fix up the "?" into "$1", etc
            var param = params[0].split('?'),
                new_param = [];
            for (var i = 0; i < param.length-1; i++){
                new_param.push(param[i], "$" + (i+1));
            }
            new_param.push(param[param.length-1]);
            params[0] = new_param.join('');
        }

        log.sql.apply(null, params);
        if(this.internals.dryRun) {
          return Promise.resolve().nodeify(callback);
        }

        return new Promise(function(resolve, reject) {
          var prCB = function(err, data) {
            return (err ? reject(err) : resolve(data));
          };

          if( minLength === 2 )
            params[params.length - 1] = prCB;
          else
            params[params.length++] = prCB;

          this.connection.query.apply(this.connection, params);
        }.bind(this)).nodeify(callback);
    },

    all: function() {
        params = arguments;

        log.sql.apply(null, params);

        return new Promise(function(resolve, reject) {
          var prCB = function(err, data) {
            return (err ? reject(err) : resolve(data));
          };

          this.connection.query.apply(this.connection, [params[0], function(err, result){
            prCB(err, (result) ? result.rows : result);
          }]);

        }.bind(this)).nodeify(params[1]);
    },

    close: function(callback) {
        this.connection.end();
        if( typeof(callback) === 'function' )
          return Promise.resolve().nodeify(callback);
        else
          return Promise.resolve();
    }

});

Promise.promisifyAll(PgDriver);

exports.connect = function(config, intern, callback) {

    internals = intern;

    log = intern.mod.log;
    type = Object.assign(intern.mod.type, { SORTKEY_COMPOUND: "compound", SORTKEY_INTERLEAVED: "interleaved" })

    if (config.native) { pg = pg.native; }
    var db = config.db || new pg.Client(config);
    callback(null, new PgDriver(db, config.schema, intern));
};
