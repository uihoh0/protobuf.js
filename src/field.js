module.exports = Field;

var ReflectionObject = require("./object");
/** @alias Field.prototype */
var FieldPrototype = ReflectionObject.extend(Field, [ "rule", "type", "id", "extend" ]);

var Type      = require("./type"),
    Enum      = require("./enum"),
    types     = require("./types"),
    util      = require("./util"),
    codegen   = require("./codegen");

/**
 * Reflected message field.
 * @extends ReflectionObject
 * @constructor
 * @param {string} name Unique name within its namespace
 * @param {number} id Unique id within its namespace
 * @param {string} type Type of the underlying value
 * @param {string} [rule=optional] Field rule
 * @param {string} [extend] Extended type if different from parent
 * @param {Object.<string,*>} [options] Field options
 */
function Field(name, id, type, rule, extend, options) {
    if (util.isObject(rule)) {
        options = rule;
        rule = extend = undefined;
    } else if (util.isObject(extend)) {
        options = extend;
        extend = undefined;
    }
    ReflectionObject.call(this, name, options);
    if (!util.isInteger(id) || id < 0)
        throw util._TypeError("id", "a non-negative integer");
    if (!util.isString(type))
        throw util._TypeError("type");
    if (extend !== undefined && !util.isString(extend))
        throw util._TypeError("extend");
    if (rule !== undefined && !/^required|optional|repeated$/.test(rule = rule.toString().toLowerCase()))
        throw util._TypeError("rule", "a valid rule string");

    /**
     * Field rule, if any.
     * @type {string|undefined}
     */
    this.rule = rule && rule !== 'optional' ? rule : undefined; // exposed

    /**
     * Field type.
     * @type {string}
     */
    this.type = type; // exposed

    /**
     * Unique field id.
     * @type {number}
     */
    this.id = id; // exposed, marker

    /**
     * Extended type if different from parent.
     * @type {string|undefined}
     */
    this.extend = extend || undefined; // exposed

    /**
     * Whether this field is required.
     * @type {boolean}
     */
    this.required = rule === "required";

    /**
     * Whether this field is optional.
     * @type {boolean}
     */
    this.optional = !this.required;

    /**
     * Whether this field is repeated.
     * @type {boolean}
     */
    this.repeated = rule === "repeated";

    /**
     * Whether this field is a map or not.
     * @type {boolean}
     */
    this.map = false;

    /**
     * Message this field belongs to.
     * @type {?Type}
     */
    this.message = null;

    /**
     * OneOf this field belongs to, if any,
     * @type {?OneOf}
     */
    this.partOf = null;

    /**
     * The field's default value. Only relevant when working with proto2.
     * @type {*}
     */
    this.defaultValue = null;

    /**
     * Resolved type if not a basic type.
     * @type {?(Type|Enum)}
     */
    this.resolvedType = null;

    /**
     * Sister-field within the extended type if a declaring extension field.
     * @type {?Field}
     */
    this.extensionField = null;

    /**
     * Sister-field within the declaring type if an extended field.
     * @type {?Field}
     */
    this.declaringField = null;

    /**
     * Internally remembers whether this field is packed.
     * @type {?boolean}
     * @private
     */
    this._packed = null;
}

Object.defineProperties(FieldPrototype, {

    /**
     * Determines whether this field is packed. Only relevant when repeated and working with proto2.
     * @name Field#packed
     * @type {boolean}
     * @readonly
     */
    packed: {
        get: function() {
            if (this._packed === null)
                this._packed = this.getOption("packed") !== false;
            return this._packed;
        }
    },

    /**
     * Determines whether this field's type is a long type (64 bit).
     * @name Field#long
     * @type {boolean}
     * @readonly
     */
    long : {
        get: function() {
            return types.longWireTypes[this.type] !== undefined;
        }
    }

});

/**
 * @override
 */
FieldPrototype.setOption = function setOption(name, value, ifNotSet) {
    if (name === "packed")
        this._packed = null;
    return ReflectionObject.prototype.setOption.call(this, name, value, ifNotSet);
};

/**
 * Tests if the specified JSON object describes a field.
 * @param {*} json Any JSON object to test
 * @returns {boolean} `true` if the object describes a field
 */
Field.testJSON = function testJSON(json) {
    return Boolean(json && json.id !== undefined);
};

/**
 * Constructs a field from JSON.
 * @param {string} name Field name
 * @param {Object} json JSON object
 * @returns {Field} Created field
 * @throws {TypeError} If arguments are invalid
 */
Field.fromJSON = function fromJSON(name, json) {
    return new Field(name, json.id, json.type, json.role, json.extend, json.options);
};

/**
 * Resolves this field's type references.
 * @returns {Field} `this`
 * @throws {Error} If any reference cannot be resolved
 */
FieldPrototype.resolve = function resolve() {
    if (this.resolved)
        return this;

    var typeDefault = types.defaults[this.type];

    // if not a basic type, resolve it
    if (typeDefault === undefined) {
        var resolved = this.parent.lookup(this.type);
        if (resolved instanceof Type) {
            this.resolvedType = resolved;
            typeDefault = null;
        } else if (resolved instanceof Enum) {
            this.resolvedType = resolved;
            typeDefault = 0;
        } else
            throw Error("unresolvable field type: " + this.type);
    }

    // when everything is resolved determine the default value
    var optionDefault;
    if (this.map)
        this.defaultValue = {};
    else if (this.repeated)
        this.defaultValue = [];
    else if (this.options && (optionDefault = this.options.default) !== undefined)
        this.defaultValue = optionDefault;
    else
        this.defaultValue = typeDefault;
    
    return ReflectionObject.prototype.resolve.call(this);
};

/**
 * Encodes the specified field value. Assumes that the field is present.
 * @param {*} value Field value
 * @param {Writer} writer Writer to encode to
 * @returns {Writer} writer
 */
FieldPrototype.encode = function encode_setup(value, writer) {
    this.encode = codegen.supported
        ? encode_generate(this)
        : encode_internal;
    return this.encode(value, writer);
};

// Codegen reference and also fallback if code generation is not supported.
function encode_internal(value, writer) {
    /* eslint-disable no-invalid-this */
    var type = this.resolvedType instanceof Enum ? "uint32" : this.type;
    if (this.repeated) {
        var i = 0, k = value.length;
        if (this.packed && types.packableWireTypes[type] !== undefined) {
            writer.fork();
            while (i < k)
                writer[type](value[i++]);
            var buf = writer.finish();
            if (buf.length)
                writer.tag(this.id, 2).bytes(buf);
        } else
            while (i < k)
                this.resolvedType.encodeDelimited_(value[i++], writer.tag(this.id, 2));
    } else {
        var wireType = types.wireTypes[type];
        if (wireType !== undefined)
            writer.tag(this.id, wireType)[type](value);
        else
            this.resolvedType.encodeDelimited_(value, writer.tag(this.id, 2));
    }
    return writer;
    /* eslint-enable no-invalid-this */
}

/**
 * Generates an encoder specific to the specified field.
 * @name Field.generateEncoder
 * @param {Field} field Field
 * @returns {function} Encoder
 */
function encode_generate(field) {
    var type = field.resolve().resolvedType instanceof Enum ? "uint32" : field.type,
        gen  = codegen("$type", "value", "writer")
    ('"use strict";');
    if (field.repeated) { gen
        ("var i = 0, k = value.length;");
        if (field.packed && types.packableWireTypes[type] !== undefined) gen
            ("writer.fork();")
            ("while (i < k)")
                ("writer.%s(value[i++]);", type)
            ("var b = writer.finish();")
            ("if (b.length)")
                ("writer.tag(%d, 2).bytes(b);", field.id);
        else gen
            ("while (i < k)")
                ("$type.encodeDelimited_(value[i++], writer.tag(%d, 2));", field.id);
    } else {
        var wireType = types.wireTypes[type];
        if (wireType !== undefined) gen
            ("writer.tag(%d, %d).%s(value);", field.id, wireType, type);
        else gen
            ("$type.encodeDelimited_(value, writer.tag(%d, 2));", field.id);
    }
    return gen
    ("return writer;")
    .eof(field.fullName + "$encode")
    .bind(field, field.resolvedType);
}

Field.generateEncoder = encode_generate;

/**
 * Converts a field value to JSON using the specified options.
 * @param {*} value Field value
 * @param {Object.<string,*>} [options] Conversion options
 * @param {Function} [options.long] Long conversion type.
 * Valid values are `String` (requires a long library) and `Number` (throws without a long library if unsafe).
 *  Defaults to the internal number/long-like representation.
 * @param {Function} [options.enum] Enum value conversion type.
 *  Only valid value is `String`.
 *  Defaults to the values' numeric ids.
 * @returns {*} Converted value
 */
FieldPrototype.jsonConvert = function(value, options) {
    if (this.repeated) {
        if (!value)
            return [];
        var self = this;
        return value.map(function(val) {
            return self.jsonConvert(val, options);
        });
    }
    if (options) {
        if (this.resolvedType instanceof Enum && options.enum === String)
            return this.resolvedType.valuesById[value];
        else if (types.longWireTypes[this.type] !== undefined && options.long)
            return options.long === Number
                ? typeof value === 'number'
                ? value
                : util.Long.fromValue(value).toNumber()
                : util.Long.fromValue(value, this.type.charAt(0) === 'u').toString();
    }
    return value;
};
