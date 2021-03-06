module.exports = Writer;

Writer.BufferWriter = BufferWriter;

var LongBits = require("./longbits"),
    util     = require("./util"),
    ieee754  = require("../lib/ieee754");

/**
 * Default buffer size.
 * @type {number}
 */
Writer.BUFFER_SIZE = 256; // For some reason this is considerably faster on node than 128 or 512.

/**
 * Wire format writer using `Uint8Array` if available, otherwise `Array`.
 * @exports Writer
 * @constructor
 */
function Writer() {
    if (!(this instanceof Writer))
        return util.Buffer
            ? new BufferWriter()
            : new Writer();

    /**
     * Current buffer.
     * @type {?number[]}
     */
    this.buf = null;

    /**
     * Current buffer position.
     * @type {number}
     */
    this.pos = 0;

    /**
     * Current buffer length.
     * @type {number}
     */
    this.len = 0;

    /**
     * Completed buffers.
     * @type {number[][]}
     */
    this.bufs = [];

    /**
     * Forked states stack.
     * @type {number[][][]}
     * @private
     */
    this._stack = [];
}

/** @alias Writer.prototype */
var WriterPrototype = Writer.prototype;

var emptyArray = null;

var ArrayImpl = typeof Uint8Array !== 'undefined'
    ? Uint8Array
    : Array;

/**
 * Sets up the Writer class before first use. This is done automatically when the first buffer is
 * allocated.
 * @returns {Function} `Writer`
 */
Writer.setup = function setup() {

    WriterPrototype._slice = ArrayImpl.prototype.slice || ArrayImpl.prototype.subarray;

    WriterPrototype._set = ArrayImpl.prototype.set || function set_array(array, offset) {
        if (offset + array.length > this.length)
            throw RangeError("offset");
        for (var i = 0, k = array.length; i < k; ++i)
            this[offset + i] = array[i];
    };

    Writer.alloc = function alloc_array(size) { return new ArrayImpl(size); };

    emptyArray = Writer.alloc(0);
    if (Object.freeze)
        try { Object.freeze(emptyArray); } catch(e) {} // eslint-disable-line no-empty

    return Writer;
};

/**
 * Allocates a chunk of memory.
 * @param {number} size Buffer size
 * @returns {number[]} Allocated buffer
 */
Writer.alloc = function alloc_array_setup(size) {
    return Writer.setup().alloc(size); // overrides this method
};

/**
 * Allocates more memory on the specified writer.
 * @param {number} writeLength Write length requested
 * @returns {Writer} `this`
 */
WriterPrototype.expand = function expand(writeLength) {
    if (this.pos)
        this.bufs.push(this._slice.call(this.buf, 0, this.pos));
    this.buf = this.constructor.alloc(this.len = Math.max(writeLength, Writer.BUFFER_SIZE));
    this.pos = 0;
    return this;
};

/**
 * Writes a tag.
 * @param {number} id Field id
 * @param {number} wireType Wire type
 * @returns {Writer} `this`
 */
WriterPrototype.tag = function write_tag(id, wireType) {
    if (this.pos + 1 > this.len)
        this.expand(1);
    this.buf[this.pos++] = (id << 3 | wireType & 7) & 255;
    return this;
};

/**
 * Writes an unsigned 32 bit value as a varint.
 * @param {number} value Value to write
 * @returns {Writer} `this`
 */
WriterPrototype.uint32 = function write_uint32(value) {
    value >>>= 0;
    if (this.pos + 4 < this.len) // fast route
        while (value > 127) {
            this.buf[this.pos++] = value & 127 | 128;
            value >>>= 7;
        }
    else {
        while (value > 127) {
            if (this.pos >= this.len)
                this.expand(1);
            this.buf[this.pos++] = value & 127 | 128;
            value >>>= 7;
        }
        if (this.pos >= this.len)
            this.expand(1);
    }
    this.buf[this.pos++] = value;
    return this;
};

/**
 * Writes a signed 32 bit value as a varint.
 * @function
 * @param {number} value Value to write
 * @returns {Writer} `this`
 */
WriterPrototype.int32 = WriterPrototype.uint32;

/**
 * Writes a 32 bit value as a varint, zig-zag encoded.
 * @param {number} value Value to write
 * @returns {Writer} `this`
 */
WriterPrototype.sint32 = function write_sint32(value) {
    return this.uint32(value << 1 ^ value >> 31);
};

/**
 * Writes a long as a varint.
 * @param {number} lo Low bits
 * @param {number} hi High bits
 * @returns {Writer} `this`
 * @private
 */
WriterPrototype._writeLongVarint = function writeLongVarint(lo, hi) {
    if (this.pos + 9 < this.len) { // fast route
        while (hi > 0 || lo > 127) {
            this.buf[this.pos++] = lo & 127 | 128;
            lo = (lo >>> 7 | hi << 25) >>> 0;
            hi >>>= 7;
        }
    } else {
        while (hi > 0 || lo > 127) {
            if (this.pos >= this.len)
                this.expand(1);
            this.buf[this.pos++] = lo & 127 | 128;
            lo = (lo >>> 7 | hi << 25) >>> 0;
            hi >>>= 7;
        }
        if (this.pos >= this.len)
            this.expand(1);
    }
    this.buf[this.pos++] = lo;
    return this;
};

/**
 * Writes an unsigned 64 bit value as a varint.
 * @param {Long|number} value Value to write
 * @returns {Writer} `this`
 */
WriterPrototype.uint64 = function write_uint64(value) {
    if (typeof value === 'number') {
        var bits = value ? LongBits.fromNumber(value) : LongBits.zero;
        return this._writeLongVarint(bits.lo, bits.hi);
    } 
    return this._writeLongVarint(value.low >>> 0, value.high >>> 0);
};

/**
 * Writes a signed 64 bit value as a varint.
 * @function
 * @param {Long|number} value Value to write
 * @returns {Writer} `this`
 */
WriterPrototype.int64 = WriterPrototype.uint64;

/**
 * Writes a signed 64 bit value as a varint, zig-zag encoded.
 * @param {Long|number} value Value to write
 * @returns {Writer} `this`
 */
WriterPrototype.sint64 = function sint64(value) {
    var bits = LongBits.fromValue(value).zzEncode();
    return this._writeLongVarint(bits.lo, bits.hi);
};

/**
 * Writes a boolish value as a varint.
 * @param {boolean} value Value to write
 * @returns {Writer} `this`
 */
WriterPrototype.bool = function write_bool(value) {
    if (this.pos >= this.len)
        this.expand(1);
    this.buf[this.pos++] = value ? 1 : 0;
    return this;
};

/**
 * Writes a 32 bit value as fixed 32 bits.
 * @param {number} value Value to write
 * @returns {Writer} `this`
 */
WriterPrototype.fixed32 = function write_fixed32(value) {
    if (this.pos + 4 > this.len)
        this.expand(4);
    this.buf[this.pos++] = (value >>>= 0) & 255;
    this.buf[this.pos++] =  value >>> 8   & 255;
    this.buf[this.pos++] =  value >>> 16  & 255;
    this.buf[this.pos++] =  value >>> 24  & 255;
    return this;
};

/**
 * Writes a 32 bit value as fixed 32 bits, zig-zag encoded.
 * @param {number} value Value to write
 * @returns {Writer} `this`
 */
WriterPrototype.sfixed32 = function write_sfixed32(value) {
    return this.fixed32(value << 1 ^ value >> 31);
};

/**
 * Writes a 64 bit value.
 * @param {number} lo Low bits
 * @param {number} hi High bits
 * @returns {Writer} `this`
 * @private
 */
WriterPrototype._writeLongFixed = function writeLongFixed(lo, hi) {
    if (this.pos + 8 > this.len)
        this.expand(8);
    this.buf[this.pos++] = lo        & 255;
    this.buf[this.pos++] = lo >>> 8  & 255;
    this.buf[this.pos++] = lo >>> 16 & 255;
    this.buf[this.pos++] = lo >>> 24      ;
    this.buf[this.pos++] = hi        & 255;
    this.buf[this.pos++] = hi >>> 8  & 255;
    this.buf[this.pos++] = hi >>> 16 & 255;
    this.buf[this.pos++] = hi >>> 24      ;
    return this;
};

/**
 * Writes a 64 bit value as fixed 64 bits.
 * @param {Long|number} value Value to write
 * @returns {Writer} `this`
 */
WriterPrototype.fixed64 = function write_fixed64(value) {
    if (typeof value === 'number') {
        var bits = value ? LongBits.fromNumber(value) : LongBits.zero;
        return this._writeLongFixed(bits.lo, bits.hi);
    }
    return this._writeLongFixed(value.low >>> 0, value.high >>> 0);
};

/**
 * Writes a 64 bit value as fixed 64 bits, zig-zag encoded.
 * @param {Long|number} value Value to write
 * @returns {Writer} `this`
 */
WriterPrototype.sfixed64 = function write_sfixed64(value) {
    var bits = LongBits.from(value).zzEncode();
    return this._writeLongFixed(bits.lo, bits.hi);
};

/**
 * Writes a float (32 bit).
 * @function
 * @param {number} value Value to write
 * @returns {Writer} `this`
 */
WriterPrototype.float = function write_float(value) {
    if (this.pos + 4 > this.len)
        this.expand(4);
    ieee754.write(this.buf, value, this.pos, false, 23, 4);
    this.pos += 4;
    return this;
};

/**
 * Writes a double (64 bit float).
 * @function
 * @param {number} value Value to write
 * @returns {Writer} `this`
 */
WriterPrototype.double = function write_double(value) {
    if (this.pos + 8 > this.len)
        this.expand(8);
    ieee754.write(this.buf, value, this.pos, false, 52, 8);
    this.pos += 8;
    return this;
};

/**
 * Writes a sequence of bytes.
 * @param {number[]} value Value to write
 * @returns {Writer} `this`
 */
WriterPrototype.bytes = function write_bytes(value) {
    var len = value.length >>> 0;
    if (len) {
        this.uint32(len);
        if (this.pos + len > this.len)
            this.expand(len);
        this._set.call(this.buf, value, this.pos);
        this.pos += len;
    } else {
        if (this.pos >= this.len)
            this.expand(1);
        this.buf[this.pos++] = 0;
    }
    return this;
};

/**
 * Writes a string.
 * @param {string} value Value to write
 * @returns {Writer} `this`
 */
WriterPrototype.string = function write_string(value) {
    // ref: https://github.com/google/closure-library/blob/master/closure/goog/crypt/crypt.js
    var len = value.length >>> 0;
    if (len) {
        var blen = 0, i = 0, c1, c2;
        for (; i < len; ++i) {
            c1 = value.charCodeAt(i);
            if (c1 < 128)
                blen += 1;
            else if (c1 < 2048)
                blen += 2;
            else if ((c1 & 0xFC00) === 0xD800 && i + 1 < len && ((c2 = value.charCodeAt(i + 1)) & 0xFC00) === 0xDC00) {
                ++i;
                blen += 4;
            } else
                blen += 3;
        }
        this.uint32(blen);
        if (this.pos + blen > this.len)
            this.expand(blen);
        for (i = 0; i < len; ++i) {
            c1 = value.charCodeAt(i);
            if (c1 < 128) {
                this.buf[this.pos++] = c1;
            } else if (c1 < 2048) {
                this.buf[this.pos++] = c1 >> 6 | 192;
                this.buf[this.pos++] = c1 & 63 | 128;
            } else if ((c1 & 0xFC00) === 0xD800 && i + 1 < len && ((c2 = value.charCodeAt(i + 1)) & 0xFC00) === 0xDC00) {
                c1 = 0x10000 + ((c1 & 0x03FF) << 10) + (c2 & 0x03FF);
                ++i;
                this.buf[this.pos++] = c1 >> 18      | 240;
                this.buf[this.pos++] = c1 >> 12 & 63 | 128;
                this.buf[this.pos++] = c1 >> 6  & 63 | 128;
                this.buf[this.pos++] = c1       & 63 | 128;
            } else {
                this.buf[this.pos++] = c1 >> 12      | 224;
                this.buf[this.pos++] = c1 >> 6  & 63 | 128;
                this.buf[this.pos++] = c1       & 63 | 128;
            }
        }
        return this;
    }
    if (this.pos >= this.len)
        this.expand(1);
    this.buf[this.pos++] = 0;
    return this;
};

/**
 * Writer state.
 * @constructor
 * @param {Writer} writer Writer to copy state from
 * @ignore
 */
function State(writer) {
    this.bufs = writer.bufs;
    this.buf  = writer.buf;
    this.pos  = writer.pos;
    this.len  = writer.len;
}

/**
 * Applies this state to the specified writer.
 * @param {Writer} writer Writer to copy state to
 * @returns {undefined}
 * @ignore
 */
State.prototype.apply = function apply(writer) {
    writer.bufs = this.bufs;
    writer.buf  = this.buf;
    writer.pos  = this.pos;
    writer.len  = this.len;
};

/**
 * Forks this writer's state by pushing it to a stack and reusing the remaining buffer
 * for a new set of write operations. A call to {@link Writer#reset} or {@link Writer#finish}
 * resets the writer to the previous state.
 * @returns {Writer} `this`
 */
WriterPrototype.fork = function fork() {
    this._stack.push(new State(this));
    this.bufs = [];
    this.buf = null;
    this.pos = this.len = 0;
    return this;
};

/**
 * Resets this instance to the last state. If there is no last state, all references
 * to previous buffers will be cleared.
 * @returns {Writer} `this`
 */
WriterPrototype.reset = function reset() {
    if (this._stack.length)
        this._stack.pop().apply(this);
    else {
        this.bufs = [];
        this.buf = null;
        this.pos = this.len = 0;
    }
    return this;
};

/**
 * Finishes the current sequence of write operations and frees all resources.
 * @returns {number[]} Finished buffer
 */
WriterPrototype.finish = function finish() {
    var bufs = this.bufs,
        buf  = this.buf,
        pos  = this.pos,
        len  = this.len;
    this.reset();
    if (buf) {
        if (pos < len)
            buf = this._slice.call(buf, 0, pos);
        if (!bufs.length)
            return buf;
    } else
        return emptyArray;
    len = pos;
    pos = 0;
    var i = 0,
        k = bufs.length;
    while (i < k)
        len += bufs[i++].length;
    var concat = this.constructor.alloc(len),
        sub;
    i = 0;
    while (i < k) {
        this._set.call(concat, sub = bufs[i++], pos);
        pos += sub.length;
    }
    this._set.call(concat, buf, pos);
    return concat;
};

/**
 * Wire format writer using node buffers.
 * @exports BufferWriter
 * @extends Writer
 * @constructor
 */
function BufferWriter() {
    Writer.call(this);
}

/** @alias BufferWriter.prototype */
var BufferWriterPrototype = BufferWriter.prototype = Object.create(Writer.prototype);
BufferWriterPrototype.constructor = BufferWriter;

var emptyBuffer = null;

/**
 * Sets up the BufferWriter class to use the available buffer implementation. This is done
 * automatically when the first buffer is allocated. If the Buffer implementation is changed
 * after the first buffer has been allocated, this method must be called again manually.
 * @returns {Function} `BufferWriter`
 */
BufferWriter.setup = function setup_buffer() {
    if (!util.Buffer)
        throw Error("Buffer is not supported");

    BufferWriterPrototype._slice = util.Buffer.prototype.slice;

    BufferWriter.alloc = util.Buffer.allocUnsafe || util.Buffer.alloc || function alloc_buffer(size) { return new util.Buffer(size); };

    emptyBuffer = BufferWriter.alloc(0);
    if (Object.freeze)
        try { Object.freeze(emptyBuffer); } catch (e) {} // eslint-disable-line no-empty

    return BufferWriter;
};

/**
 * Allocates a chunk of memory using node buffers.
 * @param {number} size Buffer size
 * @returns {Buffer} Allocated buffer
 */
BufferWriter.alloc = function alloc_buffer_setup(size) {
    return BufferWriter.setup().alloc(size); // overrides this method
};

/**
 * Writes a float (32 bit) using node buffers.
 * @param {number} value Value to write
 * @returns {BufferWriter} `this`
 */
BufferWriterPrototype.float = function write_float_buffer(value) {
    if (this.pos + 4 > this.len)
        this.expand(4);
    this.buf.writeFloatLE(value, this.pos, true);
    this.pos += 4;
    return this;
};

/**
 * Writes a double (64 bit float) using node buffers.
 * @param {number} value Value to write
 * @returns {BufferWriter} `this`
 */
BufferWriterPrototype.double = function write_double_buffer(value) {
    if (this.pos + 8 > this.len)
        this.expand(8);
    this.buf.writeDoubleLE(value, this.pos, true);
    this.pos += 8;
    return this;
};

/**
 * Writes a sequence of bytes using node buffers.
 * @param {Buffer} value Value to write
 * @returns {BufferWriter} `this`
 */
BufferWriterPrototype.bytes = function write_bytes_buffer(value) {
    var len = value.length >>> 0;
    this.uint32(len);
    if (len) {
        if (this.pos + len > this.len)
            this.expand(len);
        value.copy(this.buf, this.pos, 0, len);
        this.pos += len;
    }
    return this;
};

/**
 * Writes a string using node buffers.
 * @param {string} value Value to write
 * @returns {BufferWriter} `this`
 */
BufferWriterPrototype.string = function write_string_buffer(value) {
    var len = util.Buffer.byteLength(value);
    this.uint32(len);
    if (len) {
        if (this.pos + len > this.len)
            this.expand(len);
        this.buf.write(value, this.pos, len, "utf8");
        this.pos += len;
    }
    return this;
};

/**
 * Finishes the current sequence of write operations using node buffers and frees all resources.
 * @returns {Buffer} Finished buffer
 */
BufferWriterPrototype.finish = function finish_buffer() {
    var bufs = this.bufs,
        buf  = this.buf,
        pos  = this.pos;
    this.reset();
    if (buf) {
        var len = bufs.length;
        if (len) {
            bufs[len] = buf.slice(0, pos);
            return util.Buffer.concat(bufs);
        }
        return buf.slice(0, pos);
    }
    return emptyBuffer;
};
