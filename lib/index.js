/*
#***********************************************
#
#      Filename: gz-objection/lib/index.js
#
#        Author: wwj - 318348750@qq.com
#       Company: 甘肃国臻物联网科技有限公司
#   Description: xxx
#        Create: 2021-08-17 11:37:54
# Last Modified: 2021-08-17 11:37:59
#***********************************************
*/
'use strict';

const Boom = require('@hapi/boom');
const Joi = require('joi');
const Hoek = require('hoek');
const { DbErrors } = require('objection-db-errors');
const { Model } = require('objection');

const Pkg = require('../package.json');
# Last Modified: 2021-08-17 11:36:56
const internals = {
  schema: {
    base: Joi.object({
      wrapDbErrors: Joi.boolean(),
      boomNotFound: Joi.boolean(),
      injectServer: Joi.boolean(),
      wrapRelation: Joi.boolean(),
      proxyQueryMethods: Joi.boolean(),
      db: Joi.string()
    })
  },
  modelNameRx: /^[_$a-zA-Z][$\w]*(?:\.[_$a-zA-Z][$\w]*)*$/,
  shortcutQueryMethods: [
    'findById',
    'findByIds',
    'findOne',
    'insert',
    'insertAndFetch',
    'insertGraph',
    'insertGraphAndFetch',
    'update',
    'updateAndFetch',
    'updateAndFetchById',
    'upsertGraph',
    'upsertGraphAndFetch',
    'patch',
    'patchAndFetch',
    'patchAndFetchById',
    'delete',
    'deleteById'
  ],
  defaults: {
    wrapDbErrors: true,
    boomNotFound: true,
    injectServer: true,
    wrapRelation: true,
    addShortcutMethods: true
  },
  kServer: Symbol('server'),
  kDefaults: Symbol('defaults'),
  kWrapped: Symbol('wrapped')
};

internals.schema.pluginOptions = internals.schema.base.keys({});
internals.schema.model = internals.schema.base.keys({
  alias: Joi.array()
    .items(Joi.string())
    .single()
});
internals.schema.modelObject = Joi.object({
  name: Joi.string(),
  modelClass: [Joi.func(), Joi.object()],
  model: Joi.object(),
  options: Joi.object()
}).xor('modelClass', 'model');

internals.Models = class {
  constructor(core, defaults) {
    this[internals.kServer] = core;
    this[internals.kDefaults] = defaults;
    this.models = {};
  }

  add(name, modelClass, options, realm) {
    if (typeof name !== 'object') {
      if (typeof name === 'function') {
        modelClass = name;
        name = modelClass.name;
      }
      if (modelClass.prototype instanceof Model) {
        return this._add(name, modelClass, options, realm);
      }
      const model = class extends Model {};
      Object.defineProperties(model, Object.getOwnPropertyDescriptors(modelClass));
      return this._add(name, model, options, realm);
    }

    // {} or [{}, {}]
    const items = [].concat(name);
    for (let i = 0; i < items.length; ++i) {
      const result = Joi.validate(options, internals.schema.modelObject);
      Hoek.assert(!result.error, 'Invalid model options', result.error && result.error.annotate());
      if (result.value.modelClass) {
        this._add(result.value.name, result.value.modelClass, result.value.options || {}, realm);
      } else {
        const modelClass = class extends Model {};
        Object.defineProperties(modelClass, Object.getOwnPropertyDescriptors(result.value.model));

        this._add(result.value.name, modelClass, result.value.options || {}, realm);
      }
    }
  }

  _add(name, modelClass, options, realm) {
    Hoek.assert(typeof name === 'string', 'Name must be a string');
    Hoek.assert(name.match(internals.modelNameRx), 'Invalid name:', name);
    Hoek.assert(
      !Hoek.reach(this.models, name, { functions: false }),
      'Server model name already exists:',
      name
    );
    Hoek.assert(modelClass, `Model is required`);
    Hoek.assert(
      modelClass.prototype instanceof Model,
      `Model "${name}" must be a class of objection.Model`
    );

    Joi.assert(options, internals.schema.model, 'Invalid model options');
    const settings = Hoek.applyToDefaultsWithShallow(this[internals.kDefaults], options, ['bind']);
    // const bind = settings.bind || realm.settings.bind || null;
    const names = settings.alias || [];

    names.push(name);

    // bc
    names.push(name[0].toLowerCase() + name.substring(1));
    names.push(name.toLowerCase());

    modelClass = this._wrap(modelClass, settings);

    const db = this[internals.kServer].db(options.db);
    const connectedModel = modelClass.bindKnex(db);

    names.forEach((modelName) => this._assign(modelName, connectedModel));
  }

  _assign(name, model) {
    const path = name.split('.');
    let ref = this.models;
    for (let i = 0; i < path.length; ++i) {
      if (!ref[path[i]]) {
        ref[path[i]] = i + 1 === path.length ? model : {};
      }
      ref = ref[path[i]];
    }
  }

  _boomify(model) {
    return class extends model {
      static createNotFoundError(queryContext) {
        return Boom.notFound(`Not Found`, {
          ...queryContext
        });
      }
    };
  }

  _wrapDbErrors(model) {
    return DbErrors(model);
  }

  _injectServer(model) {
    const server = this[internals.kServer];
    return class extends model {
      static get server() {
        return server;
      }
    };
  }

  _wrapRelation(model, options) {
    if (model.relationMappings !== undefined) {
      const context = this;
      return class extends model {
        static get relationMappings() {
          const mappings = super.relationMappings;
          for (const rel of Object.keys(mappings || {})) {
            if (typeof mappings[rel].modelClass !== 'string') {
              mappings[rel].modelClass = context._wrap(mappings[rel].modelClass, options);
            }
          }
          return mappings;
        }
      };
    }
    return model;
  }

  _proxyQueryMethods(model) {
    model = class extends model {};
    internals.shortcutQueryMethods.forEach((method) =>
      Object.defineProperty(model, method, {
        writable: false,
        enumerable: true,
        configurable: false,
        value: function(...args) {
          return this.query()[method](...args);
        }
      })
    );
    return model;
  }

  _wrap(model, options) {
    if (model[internals.kWrapped]) {
      return model;
    }
    if (options.wrapDbErrors) {
      model = this._wrapDbErrors(model);
    }
    if (options.boomNotFound) {
      model = this._boomify(model);
    }
    if (options.injectServer) {
      model = this._injectServer(model);
    }
    if (options.wrapRelation) {
      model = this._wrapRelation(model, options);
    }
    if (options.addShortcutMethods) {
      model = this._proxyQueryMethods(model);
    }
    model[internals.kWrapped] = true;

    return model;
  }
};

exports.plugin = {
  pkg: Pkg,
  dependencies: ['@clickdishes/hapi-db'],
  register: async (server, options) => {
    Joi.assert(options, internals.schema.pluginOptions, 'Invalid plugin settings');

    const settings = Hoek.applyToDefaultsWithShallow(internals.defaults, options, [
      'db',
      'wrapDbErrors',
      'boomNotFound'
    ]);
    const models = new internals.Models(server, settings);

    server.decorate('server', 'models', models.models);
    server.decorate('server', 'model', function(name, modelClass = {}, options = {}) {
      models.add(name, modelClass, options, this.realm);
    });
  }
};
