// -----------------------------------------------------------------------------
// The two protobuf messages of the Assistant API, by hand (no protobuf
// library: one request shape, two fields read back). Field numbers from
// google/assistant/embedded/v1alpha2/embedded_assistant.proto (Apache-2.0):
//
// AssistRequest { AssistConfig config = 1; }
// AssistConfig  { AudioOutConfig audio_out_config = 2; DialogStateIn
//                 dialog_state_in = 3; DeviceConfig device_config = 4;
//                 string text_query = 6; }
// AudioOutConfig { Encoding encoding = 1 (MP3 = 2); int32 sample_rate_hertz
//                 = 2 (24000); int32 volume_percentage = 3 (100); }
// DialogStateIn  { string language_code = 2; bool is_new_conversation = 7; }
// DeviceConfig   { string device_id = 1; string device_model_id = 3; }
// AssistResponse { AudioOut audio_out = 3; DialogStateOut dialog_state_out = 5; }
// DialogStateOut { string supplemental_display_text = 1; }
//
// The decoder is linear, bounded by the buffer it is given, and skips every
// field it does not know (groups and unknown wire types are refused).
// -----------------------------------------------------------------------------

function varint(value) {
  const bytes = [];
  let v = value >>> 0;
  while (v > 0x7f) {
    bytes.push((v & 0x7f) | 0x80);
    v >>>= 7;
  }
  bytes.push(v);
  return Buffer.from(bytes);
}

const tag = (field, wire) => varint((field << 3) | wire);
const bytesField = (field, buffer) => Buffer.concat([tag(field, 2), varint(buffer.length), buffer]);
const stringField = (field, text) => bytesField(field, Buffer.from(text, 'utf8'));
const intField = (field, value) => Buffer.concat([tag(field, 0), varint(value)]);

/** The AssistRequest of one text query, in a new conversation. */
export function encodeAssistRequest({ text, languageCode, deviceId, deviceModelId }) {
  const audioOut = Buffer.concat([intField(1, 2), intField(2, 24000), intField(3, 100)]);
  const dialog = Buffer.concat([stringField(2, languageCode), intField(7, 1)]);
  const device = Buffer.concat([stringField(1, deviceId), stringField(3, deviceModelId)]);
  const config = Buffer.concat([
    bytesField(2, audioOut),
    bytesField(3, dialog),
    bytesField(4, device),
    stringField(6, text),
  ]);
  return bytesField(1, config);
}

function readVarint(buffer, offset) {
  let result = 0;
  let shift = 0;
  for (let i = 0; i < 10; i += 1) {
    if (offset >= buffer.length) throw new Error('truncated varint');
    const byte = buffer[offset];
    offset += 1;
    if (shift < 32) result += (byte & 0x7f) * 2 ** shift;
    shift += 7;
    if ((byte & 0x80) === 0) return [result, offset];
  }
  throw new Error('varint too long');
}

/** Each field of a message: [number, wire type, value (Buffer for length-delimited)]. */
export function* fields(buffer) {
  let offset = 0;
  while (offset < buffer.length) {
    let key;
    [key, offset] = readVarint(buffer, offset);
    const field = Math.floor(key / 8);
    const wire = key % 8;
    if (field === 0) throw new Error('field 0');
    if (wire === 0) {
      let value;
      [value, offset] = readVarint(buffer, offset);
      yield [field, wire, value];
    } else if (wire === 2) {
      let length;
      [length, offset] = readVarint(buffer, offset);
      if (offset + length > buffer.length) throw new Error('truncated field');
      yield [field, wire, buffer.subarray(offset, offset + length)];
      offset += length;
    } else if (wire === 1 || wire === 5) {
      const size = wire === 1 ? 8 : 4;
      if (offset + size > buffer.length) throw new Error('truncated field');
      offset += size;
    } else {
      throw new Error(`wire type ${wire}`);
    }
  }
}

/** What the integration reads from one AssistResponse: the display text, if any. */
export function decodeAssistResponse(buffer) {
  let text;
  for (const [field, wire, value] of fields(buffer)) {
    if (field === 5 && wire === 2) {
      for (const [inner, innerWire, innerValue] of fields(value)) {
        if (inner === 1 && innerWire === 2) text = innerValue.toString('utf8');
      }
    }
  }
  return { text };
}
