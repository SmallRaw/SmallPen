// Minimal Kiwi schema runtime carried from the migration source. It decodes the
// schema embedded in Figma clipboard payloads and intentionally has no codec schema,
// network access, filesystem access, or third-party runtime dependency.
//#region src/schema-runtime/bb.ts
let int32 = /* @__PURE__ */ new Int32Array(1);
let float32 = new Float32Array(int32.buffer);
const textDecoder = new TextDecoder();
var ByteBuffer = class {
	_data;
	_index;
	length;
	constructor(data) {
		if (data && !(data instanceof Uint8Array)) throw new Error("Must initialize a ByteBuffer with a Uint8Array");
		this._data = data || /* @__PURE__ */ new Uint8Array(256);
		this._index = 0;
		this.length = data ? data.length : 0;
	}
	get offset() {
		return this._index;
	}
	set offset(value) {
		this._index = value;
	}
	/**
	* Returns a view into the internal buffer, not a copy.
	*
	* Consumers transferring this Uint8Array across thread boundaries (e.g. via
	* postMessage with transferables) MUST copy first: `new Uint8Array(buffer)`.
	* Otherwise, if multiple Uint8Arrays share the same underlying ArrayBuffer and
	* one is transferred, all views into that buffer become detached.
	*/
	toUint8Array() {
		return this._data.subarray(0, this.length);
	}
	readByte() {
		return this._data[this._index++];
	}
	readByteArray() {
		const length = this.readVarUint();
		const start = this._index;
		this._index = start + length;
		return this._data.slice(start, start + length);
	}
	skipByteArray() {
		const length = this.readVarUint();
		this._index += length;
	}
	readVarFloat() {
		const index = this._index;
		const data = this._data;
		const first = data[index];
		if (first === 0) {
			this._index = index + 1;
			return 0;
		}
		let bits = first | data[index + 1] << 8 | data[index + 2] << 16 | data[index + 3] << 24;
		this._index = index + 4;
		bits = bits << 23 | bits >>> 9;
		int32[0] = bits;
		return float32[0];
	}
	readVarUint() {
		const data = this._data;
		let i = this._index;
		let b = data[i++];
		let value = b & 127;
		if (b < 128) {
			this._index = i;
			return value;
		}
		b = data[i++];
		value |= (b & 127) << 7;
		if (b < 128) {
			this._index = i;
			return value;
		}
		b = data[i++];
		value |= (b & 127) << 14;
		if (b < 128) {
			this._index = i;
			return value;
		}
		b = data[i++];
		value |= (b & 127) << 21;
		if (b < 128) {
			this._index = i;
			return value;
		}
		b = data[i++];
		value |= (b & 127) << 28;
		this._index = i;
		return value >>> 0;
	}
	readVarInt() {
		let value = this.readVarUint() | 0;
		return value & 1 ? ~(value >>> 1) : value >>> 1;
	}
	readVarUint64() {
		let value = BigInt(0);
		let shift = BigInt(0);
		let seven = BigInt(7);
		let byte;
		while ((byte = this.readByte()) & 128 && shift < 56) {
			value |= BigInt(byte & 127) << shift;
			shift += seven;
		}
		value |= BigInt(byte) << shift;
		return value;
	}
	readVarInt64() {
		let value = this.readVarUint64();
		let one = BigInt(1);
		let sign = value & one;
		value >>= one;
		return sign ? ~value : value;
	}
	readString() {
		const start = this._index;
		const i = this.findStringTerminator(start);
		this._index = i + 1;
		return textDecoder.decode(this._data.subarray(start, i));
	}
	skipString() {
		this._index = this.findStringTerminator(this._index) + 1;
	}
	findStringTerminator(start) {
		const data = this._data;
		let index = start;
		while (index < data.length && data[index] !== 0) index++;
		if (index >= data.length) throw new Error("Unterminated string in Kiwi message");
		return index;
	}
	_growBy(amount) {
		if (this.length + amount > this._data.length) {
			let data = new Uint8Array(this.length + amount << 1);
			data.set(this._data);
			this._data = data;
		}
		this.length += amount;
	}
	writeByte(value) {
		let index = this.length;
		this._growBy(1);
		this._data[index] = value;
	}
	writeByteArray(value) {
		this.writeVarUint(value.length);
		let index = this.length;
		this._growBy(value.length);
		this._data.set(value, index);
	}
	writeVarFloat(value) {
		let index = this.length;
		float32[0] = value;
		let bits = int32[0];
		bits = bits >>> 23 | bits << 9;
		if ((bits & 255) === 0) {
			this.writeByte(0);
			return;
		}
		this._growBy(4);
		let data = this._data;
		data[index] = bits;
		data[index + 1] = bits >> 8;
		data[index + 2] = bits >> 16;
		data[index + 3] = bits >> 24;
	}
	writeVarUint(value) {
		if (value < 0 || value > 4294967295) throw new Error("Outside uint range: " + value);
		do {
			let byte = value & 127;
			value >>>= 7;
			this.writeByte(value ? byte | 128 : byte);
		} while (value);
	}
	writeVarInt(value) {
		if (value < -2147483648 || value > 2147483647) throw new Error("Outside int range: " + value);
		this.writeVarUint((value << 1 ^ value >> 31) >>> 0);
	}
	writeVarUint64(value) {
		if (typeof value === "string") value = BigInt(value);
		else if (typeof value !== "bigint") throw new Error(`Expected bigint but got ${typeof value}: ${String(value)}`);
		if (value < 0 || value > BigInt("0xFFFFFFFFFFFFFFFF")) throw new Error("Outside uint64 range: " + value);
		let mask = BigInt(127);
		let seven = BigInt(7);
		for (let i = 0; value > mask && i < 8; i++) {
			this.writeByte(Number(value & mask) | 128);
			value >>= seven;
		}
		this.writeByte(Number(value));
	}
	writeVarInt64(value) {
		if (typeof value === "string") value = BigInt(value);
		else if (typeof value !== "bigint") throw new Error(`Expected bigint but got ${typeof value}: ${String(value)}`);
		if (value < -BigInt("0x8000000000000000") || value > BigInt("0x7FFFFFFFFFFFFFFF")) throw new Error("Outside int64 range: " + value);
		let one = BigInt(1);
		this.writeVarUint64(value < 0 ? ~(value << one) : value << one);
	}
	writeString(value) {
		let codePoint;
		for (let i = 0; i < value.length; i++) {
			let a = value.charCodeAt(i);
			if (i + 1 === value.length || a < 55296 || a >= 56320) codePoint = a;
			else {
				let b = value.charCodeAt(++i);
				codePoint = (a << 10) + b + -56613888;
			}
			if (codePoint === 0) throw new Error("Cannot encode a string containing the null character");
			if (codePoint < 128) this.writeByte(codePoint);
			else {
				if (codePoint < 2048) this.writeByte(codePoint >> 6 & 31 | 192);
				else {
					if (codePoint < 65536) this.writeByte(codePoint >> 12 & 15 | 224);
					else {
						this.writeByte(codePoint >> 18 & 7 | 240);
						this.writeByte(codePoint >> 12 & 63 | 128);
					}
					this.writeByte(codePoint >> 6 & 63 | 128);
				}
				this.writeByte(codePoint & 63 | 128);
			}
		}
		this.writeByte(0);
	}
};
//#endregion
//#region src/schema-runtime/util.ts
function quote(text) {
	return JSON.stringify(text);
}
function error(text, line, column) {
	var error = new Error(text);
	error.line = line;
	error.column = column;
	throw error;
}
//#endregion
//#region src/schema-runtime/js.ts
function compileDecode(definition, definitions) {
	let lines = [];
	let indent = "  ";
	lines.push("function (bb) {");
	lines.push("  var result = {};");
	lines.push("  if (!(bb instanceof this.ByteBuffer)) {");
	lines.push("    bb = new this.ByteBuffer(bb);");
	lines.push("  }");
	lines.push("");
	if (definition.kind === "MESSAGE") {
		lines.push("  while (true) {");
		lines.push("    switch (bb.readVarUint()) {");
		lines.push("      case 0:");
		lines.push("        return result;");
		lines.push("");
		indent = "        ";
	}
	for (let i = 0; i < definition.fields.length; i++) {
		let field = definition.fields[i];
		let code;
		switch (field.type) {
			case "bool":
				code = "!!bb.readByte()";
				break;
			case "byte":
				code = "bb.readByte()";
				break;
			case "int":
				code = "bb.readVarInt()";
				break;
			case "uint":
				code = "bb.readVarUint()";
				break;
			case "float":
				code = "bb.readVarFloat()";
				break;
			case "string":
				code = "bb.readString()";
				break;
			case "int64":
				code = "bb.readVarInt64()";
				break;
			case "uint64":
				code = "bb.readVarUint64()";
				break;
			default: {
				let type = definitions[field.type];
				if (!type) error("Invalid type " + quote(field.type) + " for field " + quote(field.name), field.line, field.column);
				else if (type.kind === "ENUM") code = "this[" + quote(type.name) + "][bb.readVarUint()]";
				else code = "this[" + quote("decode" + type.name) + "](bb)";
			}
		}
		if (definition.kind === "MESSAGE") lines.push("      case " + field.value + ":");
		if (field.isArray) {
			if (field.isDeprecated) {
				if (field.type === "byte") lines.push(indent + "bb.readByteArray();");
				else {
					lines.push(indent + "var length = bb.readVarUint();");
					lines.push(indent + "while (length-- > 0) " + code + ";");
				}
			} else if (field.type === "byte") lines.push(indent + "result[" + quote(field.name) + "] = bb.readByteArray();");
			else {
				lines.push(indent + "var length = bb.readVarUint();");
				lines.push(indent + "var values = result[" + quote(field.name) + "] = Array(length);");
				lines.push(indent + "for (var i = 0; i < length; i++) values[i] = " + code + ";");
			}
		} else if (field.isDeprecated) lines.push(indent + code + ";");
		else lines.push(indent + "result[" + quote(field.name) + "] = " + code + ";");
		if (definition.kind === "MESSAGE") {
			lines.push("        break;");
			lines.push("");
		}
	}
	if (definition.kind === "MESSAGE") {
		lines.push("      default:");
		lines.push("        throw new Error(\"Attempted to parse invalid message\");");
		lines.push("    }");
		lines.push("  }");
	} else lines.push("  return result;");
	lines.push("}");
	return lines.join("\n");
}
function compileEncode(definition, definitions) {
	let lines = [];
	lines.push("function (message, bb) {");
	lines.push("  var isTopLevel = !bb;");
	lines.push("  if (isTopLevel) bb = new this.ByteBuffer();");
	for (let j = 0; j < definition.fields.length; j++) {
		let field = definition.fields[j];
		let code;
		if (field.isDeprecated) continue;
		switch (field.type) {
			case "bool":
				code = "bb.writeByte(value);";
				break;
			case "byte":
				code = "bb.writeByte(value);";
				break;
			case "int":
				code = "bb.writeVarInt(value);";
				break;
			case "uint":
				code = "bb.writeVarUint(value);";
				break;
			case "float":
				code = "bb.writeVarFloat(value);";
				break;
			case "string":
				code = "bb.writeString(value);";
				break;
			case "int64":
				code = "bb.writeVarInt64(value);";
				break;
			case "uint64":
				code = "bb.writeVarUint64(value);";
				break;
			default: {
				let type = definitions[field.type];
				if (!type) throw new Error("Invalid type " + quote(field.type) + " for field " + quote(field.name));
				else if (type.kind === "ENUM") code = "var encoded = this[" + quote(type.name) + "][value]; if (encoded === void 0) throw new Error(\"Invalid value \" + JSON.stringify(value) + " + quote(" for enum " + quote(type.name)) + "); bb.writeVarUint(encoded);";
				else code = "this[" + quote("encode" + type.name) + "](value, bb);";
			}
		}
		lines.push("");
		lines.push("  var value = message[" + quote(field.name) + "];");
		lines.push("  if (value != null) {");
		if (definition.kind === "MESSAGE") lines.push("    bb.writeVarUint(" + field.value + ");");
		if (field.isArray) {
			if (field.type === "byte") lines.push("    bb.writeByteArray(value);");
			else {
				lines.push("    var values = value, n = values.length;");
				lines.push("    bb.writeVarUint(n);");
				lines.push("    for (var i = 0; i < n; i++) {");
				lines.push("      value = values[i];");
				lines.push("      " + code);
				lines.push("    }");
			}
		} else lines.push("    " + code);
		if (definition.kind === "STRUCT") {
			lines.push("  } else {");
			lines.push("    throw new Error(" + quote("Missing required field " + quote(field.name)) + ");");
		}
		lines.push("  }");
	}
	if (definition.kind === "MESSAGE") lines.push("  bb.writeVarUint(0);");
	lines.push("");
	lines.push("  if (isTopLevel) return bb.toUint8Array();");
	lines.push("}");
	return lines.join("\n");
}
function compileSchemaJS(schema) {
	let definitions = {};
	let name = schema.package;
	let js = [];
	if (name !== null) js.push("var " + name + " = exports || " + name + " || {}, exports;");
	else {
		js.push("var exports = exports || {};");
		name = "exports";
	}
	js.push(name + ".ByteBuffer = " + name + ".ByteBuffer || require(\"kiwi-schema\").ByteBuffer;");
	for (let i = 0; i < schema.definitions.length; i++) {
		let definition = schema.definitions[i];
		definitions[definition.name] = definition;
	}
	for (let i = 0; i < schema.definitions.length; i++) {
		let definition = schema.definitions[i];
		switch (definition.kind) {
			case "ENUM": {
				let value = {};
				for (let j = 0; j < definition.fields.length; j++) {
					let field = definition.fields[j];
					value[field.name] = field.value;
					value[field.value] = field.name;
				}
				js.push(name + "[" + quote(definition.name) + "] = " + JSON.stringify(value, null, 2) + ";");
				break;
			}
			case "STRUCT":
			case "MESSAGE":
				js.push("");
				js.push(name + "[" + quote("decode" + definition.name) + "] = " + compileDecode(definition, definitions) + ";");
				js.push("");
				js.push(name + "[" + quote("encode" + definition.name) + "] = " + compileEncode(definition, definitions) + ";");
				break;
			default: error("Invalid definition kind " + quote(definition.kind), definition.line, definition.column);
		}
	}
	js.push("");
	return js.join("\n");
}
function compileSchema(schema) {
	let result = { ByteBuffer };
	new Function("exports", compileSchemaJS(schema))(result);
	return result;
}
//#endregion
//#region src/schema-runtime/binary.ts
let types = [
	"bool",
	"byte",
	"int",
	"uint",
	"float",
	"string",
	"int64",
	"uint64"
];
let kinds = [
	"ENUM",
	"STRUCT",
	"MESSAGE"
];
function decodeBinarySchema(buffer) {
	let bb = buffer instanceof ByteBuffer ? buffer : new ByteBuffer(buffer);
	let definitionCount = bb.readVarUint();
	let definitions = [];
	for (let i = 0; i < definitionCount; i++) {
		let definitionName = bb.readString();
		let kind = bb.readByte();
		let fieldCount = bb.readVarUint();
		let fields = [];
		for (let j = 0; j < fieldCount; j++) {
			let fieldName = bb.readString();
			let type = bb.readVarInt();
			let isArray = !!(bb.readByte() & 1);
			let value = bb.readVarUint();
			fields.push({
				name: fieldName,
				line: 0,
				column: 0,
				type: kinds[kind] === "ENUM" ? null : type,
				isArray,
				isDeprecated: false,
				value
			});
		}
		definitions.push({
			name: definitionName,
			line: 0,
			column: 0,
			kind: kinds[kind],
			fields
		});
	}
	for (let i = 0; i < definitionCount; i++) {
		let fields = definitions[i].fields;
		for (let j = 0; j < fields.length; j++) {
			let field = fields[j];
			let type = field.type;
			if (type !== null && type < 0) {
				if (~type >= types.length) throw new Error("Invalid type " + type);
				field.type = types[~type];
			} else {
				if (type !== null && type >= definitions.length) throw new Error("Invalid type " + type);
				field.type = type === null ? null : definitions[type].name;
			}
		}
	}
	return {
		package: null,
		definitions
	};
}
function encodeBinarySchema(schema) {
	let bb = new ByteBuffer();
	let definitions = schema.definitions;
	let definitionIndex = {};
	bb.writeVarUint(definitions.length);
	for (let i = 0; i < definitions.length; i++) definitionIndex[definitions[i].name] = i;
	for (let i = 0; i < definitions.length; i++) {
		let definition = definitions[i];
		bb.writeString(definition.name);
		bb.writeByte(kinds.indexOf(definition.kind));
		bb.writeVarUint(definition.fields.length);
		for (let j = 0; j < definition.fields.length; j++) {
			let field = definition.fields[j];
			let type = types.indexOf(field.type);
			bb.writeString(field.name);
			bb.writeVarInt(type === -1 ? definitionIndex[field.type] : ~type);
			bb.writeByte(field.isArray ? 1 : 0);
			bb.writeVarUint(field.value);
		}
	}
	return bb.toUint8Array();
}
//#endregion

export { ByteBuffer, compileSchema, decodeBinarySchema, encodeBinarySchema };
