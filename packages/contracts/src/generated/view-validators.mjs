// Generated from Rust core DTOs. Do not edit.
// host-view-validators.mjs
var validateDerivedReadResult = validate22;
var func0 = Object.prototype.hasOwnProperty;
var pattern0 = new RegExp(
  "^(?:18446744073709551615|1[0-7][0-9]{18}|18[0-3][0-9]{17}|184[0-3][0-9]{16}|1844[0-5][0-9]{15}|18446[0-6][0-9]{14}|184467[0-3][0-9]{13}|1844674[0-3][0-9]{12}|184467440[0-6][0-9]{10}|1844674407[0-2][0-9]{9}|18446744073[0-6][0-9]{8}|1844674407370[0-8][0-9]{6}|18446744073709[0-4][0-9]{5}|184467440737095[0-4][0-9]{4}|1844674407370955[0-0][0-9]{3}|18446744073709551[0-5][0-9]{2}|184467440737095516[0-0][0-9]{1}|1844674407370955161[0-4][0-9]{0}|[1-9][0-9]{0,18}|0)$",
  "u",
);
function validate23(
  data,
  { instancePath = "", parentData, parentDataProperty, rootData = data } = {},
) {
  let vErrors = null;
  let errors = 0;
  if (typeof data === "string") {
    if (!pattern0.test(data)) {
      const err0 = {
        instancePath,
        schemaPath: "#/pattern",
        keyword: "pattern",
        params: {
          pattern:
            "^(?:18446744073709551615|1[0-7][0-9]{18}|18[0-3][0-9]{17}|184[0-3][0-9]{16}|1844[0-5][0-9]{15}|18446[0-6][0-9]{14}|184467[0-3][0-9]{13}|1844674[0-3][0-9]{12}|184467440[0-6][0-9]{10}|1844674407[0-2][0-9]{9}|18446744073[0-6][0-9]{8}|1844674407370[0-8][0-9]{6}|18446744073709[0-4][0-9]{5}|184467440737095[0-4][0-9]{4}|1844674407370955[0-0][0-9]{3}|18446744073709551[0-5][0-9]{2}|184467440737095516[0-0][0-9]{1}|1844674407370955161[0-4][0-9]{0}|[1-9][0-9]{0,18}|0)$",
        },
        message:
          'must match pattern "^(?:18446744073709551615|1[0-7][0-9]{18}|18[0-3][0-9]{17}|184[0-3][0-9]{16}|1844[0-5][0-9]{15}|18446[0-6][0-9]{14}|184467[0-3][0-9]{13}|1844674[0-3][0-9]{12}|184467440[0-6][0-9]{10}|1844674407[0-2][0-9]{9}|18446744073[0-6][0-9]{8}|1844674407370[0-8][0-9]{6}|18446744073709[0-4][0-9]{5}|184467440737095[0-4][0-9]{4}|1844674407370955[0-0][0-9]{3}|18446744073709551[0-5][0-9]{2}|184467440737095516[0-0][0-9]{1}|1844674407370955161[0-4][0-9]{0}|[1-9][0-9]{0,18}|0)$"',
      };
      if (vErrors === null) {
        vErrors = [err0];
      } else {
        vErrors.push(err0);
      }
      errors++;
    }
  } else {
    const err1 = {
      instancePath,
      schemaPath: "#/type",
      keyword: "type",
      params: { type: "string" },
      message: "must be string",
    };
    if (vErrors === null) {
      vErrors = [err1];
    } else {
      vErrors.push(err1);
    }
    errors++;
  }
  validate23.errors = vErrors;
  return errors === 0;
}
var pattern1 = new RegExp("^[A-Za-z0-9._:-]{1,128}$", "u");
function validate26(
  data,
  { instancePath = "", parentData, parentDataProperty, rootData = data } = {},
) {
  let vErrors = null;
  let errors = 0;
  if (typeof data === "string") {
    if (!pattern1.test(data)) {
      const err0 = {
        instancePath,
        schemaPath: "#/pattern",
        keyword: "pattern",
        params: { pattern: "^[A-Za-z0-9._:-]{1,128}$" },
        message: 'must match pattern "^[A-Za-z0-9._:-]{1,128}$"',
      };
      if (vErrors === null) {
        vErrors = [err0];
      } else {
        vErrors.push(err0);
      }
      errors++;
    }
  } else {
    const err1 = {
      instancePath,
      schemaPath: "#/type",
      keyword: "type",
      params: { type: "string" },
      message: "must be string",
    };
    if (vErrors === null) {
      vErrors = [err1];
    } else {
      vErrors.push(err1);
    }
    errors++;
  }
  validate26.errors = vErrors;
  return errors === 0;
}
var pattern2 = new RegExp("^[0-9a-f]{64}$", "u");
function validate31(
  data,
  { instancePath = "", parentData, parentDataProperty, rootData = data } = {},
) {
  let vErrors = null;
  let errors = 0;
  if (typeof data === "string") {
    if (!pattern2.test(data)) {
      const err0 = {
        instancePath,
        schemaPath: "#/pattern",
        keyword: "pattern",
        params: { pattern: "^[0-9a-f]{64}$" },
        message: 'must match pattern "^[0-9a-f]{64}$"',
      };
      if (vErrors === null) {
        vErrors = [err0];
      } else {
        vErrors.push(err0);
      }
      errors++;
    }
  } else {
    const err1 = {
      instancePath,
      schemaPath: "#/type",
      keyword: "type",
      params: { type: "string" },
      message: "must be string",
    };
    if (vErrors === null) {
      vErrors = [err1];
    } else {
      vErrors.push(err1);
    }
    errors++;
  }
  validate31.errors = vErrors;
  return errors === 0;
}
var schema13 = {
  enum: ["complete", "gap", "partial", "unknown", "transformed"],
  type: "string",
};
function validate34(
  data,
  { instancePath = "", parentData, parentDataProperty, rootData = data } = {},
) {
  let vErrors = null;
  let errors = 0;
  if (typeof data !== "string") {
    const err0 = {
      instancePath,
      schemaPath: "#/type",
      keyword: "type",
      params: { type: "string" },
      message: "must be string",
    };
    if (vErrors === null) {
      vErrors = [err0];
    } else {
      vErrors.push(err0);
    }
    errors++;
  }
  if (!(
    data === "complete" ||
    data === "gap" ||
    data === "partial" ||
    data === "unknown" ||
    data === "transformed"
  )) {
    const err1 = {
      instancePath,
      schemaPath: "#/enum",
      keyword: "enum",
      params: { allowedValues: schema13.enum },
      message: "must be equal to one of the allowed values",
    };
    if (vErrors === null) {
      vErrors = [err1];
    } else {
      vErrors.push(err1);
    }
    errors++;
  }
  validate34.errors = vErrors;
  return errors === 0;
}
var schema15 = { enum: ["rx", "tx"], type: "string" };
function validate39(
  data,
  { instancePath = "", parentData, parentDataProperty, rootData = data } = {},
) {
  let vErrors = null;
  let errors = 0;
  if (typeof data !== "string") {
    const err0 = {
      instancePath,
      schemaPath: "#/type",
      keyword: "type",
      params: { type: "string" },
      message: "must be string",
    };
    if (vErrors === null) {
      vErrors = [err0];
    } else {
      vErrors.push(err0);
    }
    errors++;
  }
  if (!(data === "rx" || data === "tx")) {
    const err1 = {
      instancePath,
      schemaPath: "#/enum",
      keyword: "enum",
      params: { allowedValues: schema15.enum },
      message: "must be equal to one of the allowed values",
    };
    if (vErrors === null) {
      vErrors = [err1];
    } else {
      vErrors.push(err1);
    }
    errors++;
  }
  validate39.errors = vErrors;
  return errors === 0;
}
function validate36(
  data,
  { instancePath = "", parentData, parentDataProperty, rootData = data } = {},
) {
  let vErrors = null;
  let errors = 0;
  if (data && typeof data == "object" && !Array.isArray(data)) {
    if (data.hostId === void 0 || !func0.call(data, "hostId")) {
      const err0 = {
        instancePath,
        schemaPath: "#/required",
        keyword: "required",
        params: { missingProperty: "hostId" },
        message: "must have required property 'hostId'",
      };
      if (vErrors === null) {
        vErrors = [err0];
      } else {
        vErrors.push(err0);
      }
      errors++;
    }
    if (data.sessionId === void 0 || !func0.call(data, "sessionId")) {
      const err1 = {
        instancePath,
        schemaPath: "#/required",
        keyword: "required",
        params: { missingProperty: "sessionId" },
        message: "must have required property 'sessionId'",
      };
      if (vErrors === null) {
        vErrors = [err1];
      } else {
        vErrors.push(err1);
      }
      errors++;
    }
    if (data.sessionEpoch === void 0 || !func0.call(data, "sessionEpoch")) {
      const err2 = {
        instancePath,
        schemaPath: "#/required",
        keyword: "required",
        params: { missingProperty: "sessionEpoch" },
        message: "must have required property 'sessionEpoch'",
      };
      if (vErrors === null) {
        vErrors = [err2];
      } else {
        vErrors.push(err2);
      }
      errors++;
    }
    if (data.eventStart === void 0 || !func0.call(data, "eventStart")) {
      const err3 = {
        instancePath,
        schemaPath: "#/required",
        keyword: "required",
        params: { missingProperty: "eventStart" },
        message: "must have required property 'eventStart'",
      };
      if (vErrors === null) {
        vErrors = [err3];
      } else {
        vErrors.push(err3);
      }
      errors++;
    }
    if (data.eventEnd === void 0 || !func0.call(data, "eventEnd")) {
      const err4 = {
        instancePath,
        schemaPath: "#/required",
        keyword: "required",
        params: { missingProperty: "eventEnd" },
        message: "must have required property 'eventEnd'",
      };
      if (vErrors === null) {
        vErrors = [err4];
      } else {
        vErrors.push(err4);
      }
      errors++;
    }
    for (const key0 of Object.keys(data)) {
      if (!(
        key0 === "byteEnd" ||
        key0 === "byteStart" ||
        key0 === "direction" ||
        key0 === "eventEnd" ||
        key0 === "eventStart" ||
        key0 === "hostId" ||
        key0 === "sessionEpoch" ||
        key0 === "sessionId"
      )) {
        const err5 = {
          instancePath,
          schemaPath: "#/additionalProperties",
          keyword: "additionalProperties",
          params: { additionalProperty: key0 },
          message: "must NOT have additional properties",
        };
        if (vErrors === null) {
          vErrors = [err5];
        } else {
          vErrors.push(err5);
        }
        errors++;
      }
    }
    if (data.byteEnd !== void 0 && func0.call(data, "byteEnd")) {
      if (
        !validate23(data.byteEnd, {
          instancePath: instancePath + "/byteEnd",
          parentData: data,
          parentDataProperty: "byteEnd",
          rootData,
        })
      ) {
        vErrors =
          vErrors === null
            ? validate23.errors
            : vErrors.concat(validate23.errors);
        errors = vErrors.length;
      }
    }
    if (data.byteStart !== void 0 && func0.call(data, "byteStart")) {
      if (
        !validate23(data.byteStart, {
          instancePath: instancePath + "/byteStart",
          parentData: data,
          parentDataProperty: "byteStart",
          rootData,
        })
      ) {
        vErrors =
          vErrors === null
            ? validate23.errors
            : vErrors.concat(validate23.errors);
        errors = vErrors.length;
      }
    }
    if (data.direction !== void 0 && func0.call(data, "direction")) {
      if (
        !validate39(data.direction, {
          instancePath: instancePath + "/direction",
          parentData: data,
          parentDataProperty: "direction",
          rootData,
        })
      ) {
        vErrors =
          vErrors === null
            ? validate39.errors
            : vErrors.concat(validate39.errors);
        errors = vErrors.length;
      }
    }
    if (data.eventEnd !== void 0 && func0.call(data, "eventEnd")) {
      if (
        !validate23(data.eventEnd, {
          instancePath: instancePath + "/eventEnd",
          parentData: data,
          parentDataProperty: "eventEnd",
          rootData,
        })
      ) {
        vErrors =
          vErrors === null
            ? validate23.errors
            : vErrors.concat(validate23.errors);
        errors = vErrors.length;
      }
    }
    if (data.eventStart !== void 0 && func0.call(data, "eventStart")) {
      if (
        !validate23(data.eventStart, {
          instancePath: instancePath + "/eventStart",
          parentData: data,
          parentDataProperty: "eventStart",
          rootData,
        })
      ) {
        vErrors =
          vErrors === null
            ? validate23.errors
            : vErrors.concat(validate23.errors);
        errors = vErrors.length;
      }
    }
    if (data.hostId !== void 0 && func0.call(data, "hostId")) {
      if (
        !validate26(data.hostId, {
          instancePath: instancePath + "/hostId",
          parentData: data,
          parentDataProperty: "hostId",
          rootData,
        })
      ) {
        vErrors =
          vErrors === null
            ? validate26.errors
            : vErrors.concat(validate26.errors);
        errors = vErrors.length;
      }
    }
    if (data.sessionEpoch !== void 0 && func0.call(data, "sessionEpoch")) {
      if (
        !validate23(data.sessionEpoch, {
          instancePath: instancePath + "/sessionEpoch",
          parentData: data,
          parentDataProperty: "sessionEpoch",
          rootData,
        })
      ) {
        vErrors =
          vErrors === null
            ? validate23.errors
            : vErrors.concat(validate23.errors);
        errors = vErrors.length;
      }
    }
    if (data.sessionId !== void 0 && func0.call(data, "sessionId")) {
      if (
        !validate26(data.sessionId, {
          instancePath: instancePath + "/sessionId",
          parentData: data,
          parentDataProperty: "sessionId",
          rootData,
        })
      ) {
        vErrors =
          vErrors === null
            ? validate26.errors
            : vErrors.concat(validate26.errors);
        errors = vErrors.length;
      }
    }
  } else {
    const err6 = {
      instancePath,
      schemaPath: "#/type",
      keyword: "type",
      params: { type: "object" },
      message: "must be object",
    };
    if (vErrors === null) {
      vErrors = [err6];
    } else {
      vErrors.push(err6);
    }
    errors++;
  }
  validate36.errors = vErrors;
  return errors === 0;
}
function validate30(
  data,
  { instancePath = "", parentData, parentDataProperty, rootData = data } = {},
) {
  let vErrors = null;
  let errors = 0;
  if (data && typeof data == "object" && !Array.isArray(data)) {
    if (data.sources === void 0 || !func0.call(data, "sources")) {
      const err0 = {
        instancePath,
        schemaPath: "#/required",
        keyword: "required",
        params: { missingProperty: "sources" },
        message: "must have required property 'sources'",
      };
      if (vErrors === null) {
        vErrors = [err0];
      } else {
        vErrors.push(err0);
      }
      errors++;
    }
    if (data.parserId === void 0 || !func0.call(data, "parserId")) {
      const err1 = {
        instancePath,
        schemaPath: "#/required",
        keyword: "required",
        params: { missingProperty: "parserId" },
        message: "must have required property 'parserId'",
      };
      if (vErrors === null) {
        vErrors = [err1];
      } else {
        vErrors.push(err1);
      }
      errors++;
    }
    if (data.parserVersion === void 0 || !func0.call(data, "parserVersion")) {
      const err2 = {
        instancePath,
        schemaPath: "#/required",
        keyword: "required",
        params: { missingProperty: "parserVersion" },
        message: "must have required property 'parserVersion'",
      };
      if (vErrors === null) {
        vErrors = [err2];
      } else {
        vErrors.push(err2);
      }
      errors++;
    }
    if (
      data.configurationDigest === void 0 ||
      !func0.call(data, "configurationDigest")
    ) {
      const err3 = {
        instancePath,
        schemaPath: "#/required",
        keyword: "required",
        params: { missingProperty: "configurationDigest" },
        message: "must have required property 'configurationDigest'",
      };
      if (vErrors === null) {
        vErrors = [err3];
      } else {
        vErrors.push(err3);
      }
      errors++;
    }
    if (data.quality === void 0 || !func0.call(data, "quality")) {
      const err4 = {
        instancePath,
        schemaPath: "#/required",
        keyword: "required",
        params: { missingProperty: "quality" },
        message: "must have required property 'quality'",
      };
      if (vErrors === null) {
        vErrors = [err4];
      } else {
        vErrors.push(err4);
      }
      errors++;
    }
    for (const key0 of Object.keys(data)) {
      if (!(
        key0 === "configurationDigest" ||
        key0 === "parserId" ||
        key0 === "parserVersion" ||
        key0 === "quality" ||
        key0 === "sources" ||
        key0 === "unit"
      )) {
        const err5 = {
          instancePath,
          schemaPath: "#/additionalProperties",
          keyword: "additionalProperties",
          params: { additionalProperty: key0 },
          message: "must NOT have additional properties",
        };
        if (vErrors === null) {
          vErrors = [err5];
        } else {
          vErrors.push(err5);
        }
        errors++;
      }
    }
    if (
      data.configurationDigest !== void 0 &&
      func0.call(data, "configurationDigest")
    ) {
      if (
        !validate31(data.configurationDigest, {
          instancePath: instancePath + "/configurationDigest",
          parentData: data,
          parentDataProperty: "configurationDigest",
          rootData,
        })
      ) {
        vErrors =
          vErrors === null
            ? validate31.errors
            : vErrors.concat(validate31.errors);
        errors = vErrors.length;
      }
    }
    if (data.parserId !== void 0 && func0.call(data, "parserId")) {
      if (
        !validate26(data.parserId, {
          instancePath: instancePath + "/parserId",
          parentData: data,
          parentDataProperty: "parserId",
          rootData,
        })
      ) {
        vErrors =
          vErrors === null
            ? validate26.errors
            : vErrors.concat(validate26.errors);
        errors = vErrors.length;
      }
    }
    if (data.parserVersion !== void 0 && func0.call(data, "parserVersion")) {
      if (typeof data.parserVersion !== "string") {
        const err6 = {
          instancePath: instancePath + "/parserVersion",
          schemaPath: "#/properties/parserVersion/type",
          keyword: "type",
          params: { type: "string" },
          message: "must be string",
        };
        if (vErrors === null) {
          vErrors = [err6];
        } else {
          vErrors.push(err6);
        }
        errors++;
      }
    }
    if (data.quality !== void 0 && func0.call(data, "quality")) {
      let data3 = data.quality;
      if (Array.isArray(data3)) {
        const len0 = data3.length;
        for (let i0 = 0; i0 < len0; i0++) {
          if (
            !validate34(data3[i0], {
              instancePath: instancePath + "/quality/" + i0,
              parentData: data3,
              parentDataProperty: i0,
              rootData,
            })
          ) {
            vErrors =
              vErrors === null
                ? validate34.errors
                : vErrors.concat(validate34.errors);
            errors = vErrors.length;
          }
        }
      } else {
        const err7 = {
          instancePath: instancePath + "/quality",
          schemaPath: "#/properties/quality/type",
          keyword: "type",
          params: { type: "array" },
          message: "must be array",
        };
        if (vErrors === null) {
          vErrors = [err7];
        } else {
          vErrors.push(err7);
        }
        errors++;
      }
    }
    if (data.sources !== void 0 && func0.call(data, "sources")) {
      let data5 = data.sources;
      if (Array.isArray(data5)) {
        const len1 = data5.length;
        for (let i1 = 0; i1 < len1; i1++) {
          if (
            !validate36(data5[i1], {
              instancePath: instancePath + "/sources/" + i1,
              parentData: data5,
              parentDataProperty: i1,
              rootData,
            })
          ) {
            vErrors =
              vErrors === null
                ? validate36.errors
                : vErrors.concat(validate36.errors);
            errors = vErrors.length;
          }
        }
      } else {
        const err8 = {
          instancePath: instancePath + "/sources",
          schemaPath: "#/properties/sources/type",
          keyword: "type",
          params: { type: "array" },
          message: "must be array",
        };
        if (vErrors === null) {
          vErrors = [err8];
        } else {
          vErrors.push(err8);
        }
        errors++;
      }
    }
    if (data.unit !== void 0 && func0.call(data, "unit")) {
      if (typeof data.unit !== "string") {
        const err9 = {
          instancePath: instancePath + "/unit",
          schemaPath: "#/properties/unit/type",
          keyword: "type",
          params: { type: "string" },
          message: "must be string",
        };
        if (vErrors === null) {
          vErrors = [err9];
        } else {
          vErrors.push(err9);
        }
        errors++;
      }
    }
  } else {
    const err10 = {
      instancePath,
      schemaPath: "#/type",
      keyword: "type",
      params: { type: "object" },
      message: "must be object",
    };
    if (vErrors === null) {
      vErrors = [err10];
    } else {
      vErrors.push(err10);
    }
    errors++;
  }
  validate30.errors = vErrors;
  return errors === 0;
}
var wrapper0 = { validate: validate48 };
function validate48(
  data,
  { instancePath = "", parentData, parentDataProperty, rootData = data } = {},
) {
  let vErrors = null;
  let errors = 0;
  const _errs0 = errors;
  let valid0 = false;
  const _errs1 = errors;
  if (data !== null) {
    const err0 = {
      instancePath,
      schemaPath: "#/anyOf/0/type",
      keyword: "type",
      params: { type: "null" },
      message: "must be null",
    };
    if (vErrors === null) {
      vErrors = [err0];
    } else {
      vErrors.push(err0);
    }
    errors++;
  }
  var _valid0 = _errs1 === errors;
  valid0 = valid0 || _valid0;
  if (!valid0) {
    const _errs3 = errors;
    if (typeof data !== "boolean") {
      const err1 = {
        instancePath,
        schemaPath: "#/anyOf/1/type",
        keyword: "type",
        params: { type: "boolean" },
        message: "must be boolean",
      };
      if (vErrors === null) {
        vErrors = [err1];
      } else {
        vErrors.push(err1);
      }
      errors++;
    }
    var _valid0 = _errs3 === errors;
    valid0 = valid0 || _valid0;
    if (!valid0) {
      const _errs5 = errors;
      if (!(typeof data == "number" && isFinite(data))) {
        const err2 = {
          instancePath,
          schemaPath: "#/anyOf/2/type",
          keyword: "type",
          params: { type: "number" },
          message: "must be number",
        };
        if (vErrors === null) {
          vErrors = [err2];
        } else {
          vErrors.push(err2);
        }
        errors++;
      }
      var _valid0 = _errs5 === errors;
      valid0 = valid0 || _valid0;
      if (!valid0) {
        const _errs7 = errors;
        if (typeof data !== "string") {
          const err3 = {
            instancePath,
            schemaPath: "#/anyOf/3/type",
            keyword: "type",
            params: { type: "string" },
            message: "must be string",
          };
          if (vErrors === null) {
            vErrors = [err3];
          } else {
            vErrors.push(err3);
          }
          errors++;
        }
        var _valid0 = _errs7 === errors;
        valid0 = valid0 || _valid0;
        if (!valid0) {
          const _errs9 = errors;
          if (Array.isArray(data)) {
            const len0 = data.length;
            for (let i0 = 0; i0 < len0; i0++) {
              if (
                !wrapper0.validate(data[i0], {
                  instancePath: instancePath + "/" + i0,
                  parentData: data,
                  parentDataProperty: i0,
                  rootData,
                })
              ) {
                vErrors =
                  vErrors === null
                    ? wrapper0.validate.errors
                    : vErrors.concat(wrapper0.validate.errors);
                errors = vErrors.length;
              }
            }
          } else {
            const err4 = {
              instancePath,
              schemaPath: "#/anyOf/4/type",
              keyword: "type",
              params: { type: "array" },
              message: "must be array",
            };
            if (vErrors === null) {
              vErrors = [err4];
            } else {
              vErrors.push(err4);
            }
            errors++;
          }
          var _valid0 = _errs9 === errors;
          valid0 = valid0 || _valid0;
          if (!valid0) {
            const _errs12 = errors;
            if (data && typeof data == "object" && !Array.isArray(data)) {
              for (const key0 of Object.keys(data)) {
                if (
                  !wrapper0.validate(data[key0], {
                    instancePath:
                      instancePath +
                      "/" +
                      key0.replace(/~/g, "~0").replace(/\//g, "~1"),
                    parentData: data,
                    parentDataProperty: key0,
                    rootData,
                  })
                ) {
                  vErrors =
                    vErrors === null
                      ? wrapper0.validate.errors
                      : vErrors.concat(wrapper0.validate.errors);
                  errors = vErrors.length;
                }
              }
            } else {
              const err5 = {
                instancePath,
                schemaPath: "#/anyOf/5/type",
                keyword: "type",
                params: { type: "object" },
                message: "must be object",
              };
              if (vErrors === null) {
                vErrors = [err5];
              } else {
                vErrors.push(err5);
              }
              errors++;
            }
            var _valid0 = _errs12 === errors;
            valid0 = valid0 || _valid0;
          }
        }
      }
    }
  }
  if (!valid0) {
    const err6 = {
      instancePath,
      schemaPath: "#/anyOf",
      keyword: "anyOf",
      params: {},
      message: "must match a schema in anyOf",
    };
    if (vErrors === null) {
      vErrors = [err6];
    } else {
      vErrors.push(err6);
    }
    errors++;
  } else {
    errors = _errs0;
    if (vErrors !== null) {
      if (_errs0) {
        vErrors.length = _errs0;
      } else {
        vErrors = null;
      }
    }
  }
  validate48.errors = vErrors;
  return errors === 0;
}
function validate28(
  data,
  { instancePath = "", parentData, parentDataProperty, rootData = data } = {},
) {
  let vErrors = null;
  let errors = 0;
  if (data && typeof data == "object" && !Array.isArray(data)) {
    if (data.position === void 0 || !func0.call(data, "position")) {
      const err0 = {
        instancePath,
        schemaPath: "#/required",
        keyword: "required",
        params: { missingProperty: "position" },
        message: "must have required property 'position'",
      };
      if (vErrors === null) {
        vErrors = [err0];
      } else {
        vErrors.push(err0);
      }
      errors++;
    }
    if (data.provenance === void 0 || !func0.call(data, "provenance")) {
      const err1 = {
        instancePath,
        schemaPath: "#/required",
        keyword: "required",
        params: { missingProperty: "provenance" },
        message: "must have required property 'provenance'",
      };
      if (vErrors === null) {
        vErrors = [err1];
      } else {
        vErrors.push(err1);
      }
      errors++;
    }
    if (data.value === void 0 || !func0.call(data, "value")) {
      const err2 = {
        instancePath,
        schemaPath: "#/required",
        keyword: "required",
        params: { missingProperty: "value" },
        message: "must have required property 'value'",
      };
      if (vErrors === null) {
        vErrors = [err2];
      } else {
        vErrors.push(err2);
      }
      errors++;
    }
    for (const key0 of Object.keys(data)) {
      if (!(key0 === "position" || key0 === "provenance" || key0 === "value")) {
        const err3 = {
          instancePath,
          schemaPath: "#/additionalProperties",
          keyword: "additionalProperties",
          params: { additionalProperty: key0 },
          message: "must NOT have additional properties",
        };
        if (vErrors === null) {
          vErrors = [err3];
        } else {
          vErrors.push(err3);
        }
        errors++;
      }
    }
    if (data.position !== void 0 && func0.call(data, "position")) {
      if (
        !validate23(data.position, {
          instancePath: instancePath + "/position",
          parentData: data,
          parentDataProperty: "position",
          rootData,
        })
      ) {
        vErrors =
          vErrors === null
            ? validate23.errors
            : vErrors.concat(validate23.errors);
        errors = vErrors.length;
      }
    }
    if (data.provenance !== void 0 && func0.call(data, "provenance")) {
      if (
        !validate30(data.provenance, {
          instancePath: instancePath + "/provenance",
          parentData: data,
          parentDataProperty: "provenance",
          rootData,
        })
      ) {
        vErrors =
          vErrors === null
            ? validate30.errors
            : vErrors.concat(validate30.errors);
        errors = vErrors.length;
      }
    }
    if (data.value !== void 0 && func0.call(data, "value")) {
      if (
        !validate48(data.value, {
          instancePath: instancePath + "/value",
          parentData: data,
          parentDataProperty: "value",
          rootData,
        })
      ) {
        vErrors =
          vErrors === null
            ? validate48.errors
            : vErrors.concat(validate48.errors);
        errors = vErrors.length;
      }
    }
  } else {
    const err4 = {
      instancePath,
      schemaPath: "#/type",
      keyword: "type",
      params: { type: "object" },
      message: "must be object",
    };
    if (vErrors === null) {
      vErrors = [err4];
    } else {
      vErrors.push(err4);
    }
    errors++;
  }
  validate28.errors = vErrors;
  return errors === 0;
}
function validate22(
  data,
  { instancePath = "", parentData, parentDataProperty, rootData = data } = {},
) {
  let vErrors = null;
  let errors = 0;
  if (data && typeof data == "object" && !Array.isArray(data)) {
    if (data.operationId === void 0 || !func0.call(data, "operationId")) {
      const err0 = {
        instancePath,
        schemaPath: "#/required",
        keyword: "required",
        params: { missingProperty: "operationId" },
        message: "must have required property 'operationId'",
      };
      if (vErrors === null) {
        vErrors = [err0];
      } else {
        vErrors.push(err0);
      }
      errors++;
    }
    if (data.instanceEpoch === void 0 || !func0.call(data, "instanceEpoch")) {
      const err1 = {
        instancePath,
        schemaPath: "#/required",
        keyword: "required",
        params: { missingProperty: "instanceEpoch" },
        message: "must have required property 'instanceEpoch'",
      };
      if (vErrors === null) {
        vErrors = [err1];
      } else {
        vErrors.push(err1);
      }
      errors++;
    }
    if (data.samples === void 0 || !func0.call(data, "samples")) {
      const err2 = {
        instancePath,
        schemaPath: "#/required",
        keyword: "required",
        params: { missingProperty: "samples" },
        message: "must have required property 'samples'",
      };
      if (vErrors === null) {
        vErrors = [err2];
      } else {
        vErrors.push(err2);
      }
      errors++;
    }
    if (data.nextPosition === void 0 || !func0.call(data, "nextPosition")) {
      const err3 = {
        instancePath,
        schemaPath: "#/required",
        keyword: "required",
        params: { missingProperty: "nextPosition" },
        message: "must have required property 'nextPosition'",
      };
      if (vErrors === null) {
        vErrors = [err3];
      } else {
        vErrors.push(err3);
      }
      errors++;
    }
    if (data.hasMore === void 0 || !func0.call(data, "hasMore")) {
      const err4 = {
        instancePath,
        schemaPath: "#/required",
        keyword: "required",
        params: { missingProperty: "hasMore" },
        message: "must have required property 'hasMore'",
      };
      if (vErrors === null) {
        vErrors = [err4];
      } else {
        vErrors.push(err4);
      }
      errors++;
    }
    for (const key0 of Object.keys(data)) {
      if (!(
        key0 === "hasMore" ||
        key0 === "instanceEpoch" ||
        key0 === "nextPosition" ||
        key0 === "operationId" ||
        key0 === "samples"
      )) {
        const err5 = {
          instancePath,
          schemaPath: "#/additionalProperties",
          keyword: "additionalProperties",
          params: { additionalProperty: key0 },
          message: "must NOT have additional properties",
        };
        if (vErrors === null) {
          vErrors = [err5];
        } else {
          vErrors.push(err5);
        }
        errors++;
      }
    }
    if (data.hasMore !== void 0 && func0.call(data, "hasMore")) {
      if (typeof data.hasMore !== "boolean") {
        const err6 = {
          instancePath: instancePath + "/hasMore",
          schemaPath: "#/properties/hasMore/type",
          keyword: "type",
          params: { type: "boolean" },
          message: "must be boolean",
        };
        if (vErrors === null) {
          vErrors = [err6];
        } else {
          vErrors.push(err6);
        }
        errors++;
      }
    }
    if (data.instanceEpoch !== void 0 && func0.call(data, "instanceEpoch")) {
      if (
        !validate23(data.instanceEpoch, {
          instancePath: instancePath + "/instanceEpoch",
          parentData: data,
          parentDataProperty: "instanceEpoch",
          rootData,
        })
      ) {
        vErrors =
          vErrors === null
            ? validate23.errors
            : vErrors.concat(validate23.errors);
        errors = vErrors.length;
      }
    }
    if (data.nextPosition !== void 0 && func0.call(data, "nextPosition")) {
      if (
        !validate23(data.nextPosition, {
          instancePath: instancePath + "/nextPosition",
          parentData: data,
          parentDataProperty: "nextPosition",
          rootData,
        })
      ) {
        vErrors =
          vErrors === null
            ? validate23.errors
            : vErrors.concat(validate23.errors);
        errors = vErrors.length;
      }
    }
    if (data.operationId !== void 0 && func0.call(data, "operationId")) {
      if (
        !validate26(data.operationId, {
          instancePath: instancePath + "/operationId",
          parentData: data,
          parentDataProperty: "operationId",
          rootData,
        })
      ) {
        vErrors =
          vErrors === null
            ? validate26.errors
            : vErrors.concat(validate26.errors);
        errors = vErrors.length;
      }
    }
    if (data.samples !== void 0 && func0.call(data, "samples")) {
      let data4 = data.samples;
      if (Array.isArray(data4)) {
        const len0 = data4.length;
        for (let i0 = 0; i0 < len0; i0++) {
          if (
            !validate28(data4[i0], {
              instancePath: instancePath + "/samples/" + i0,
              parentData: data4,
              parentDataProperty: i0,
              rootData,
            })
          ) {
            vErrors =
              vErrors === null
                ? validate28.errors
                : vErrors.concat(validate28.errors);
            errors = vErrors.length;
          }
        }
      } else {
        const err7 = {
          instancePath: instancePath + "/samples",
          schemaPath: "#/properties/samples/type",
          keyword: "type",
          params: { type: "array" },
          message: "must be array",
        };
        if (vErrors === null) {
          vErrors = [err7];
        } else {
          vErrors.push(err7);
        }
        errors++;
      }
    }
  } else {
    const err8 = {
      instancePath,
      schemaPath: "#/type",
      keyword: "type",
      params: { type: "object" },
      message: "must be object",
    };
    if (vErrors === null) {
      vErrors = [err8];
    } else {
      vErrors.push(err8);
    }
    errors++;
  }
  validate22.errors = vErrors;
  return errors === 0;
}
var validateHostError = validate51;
function validate53(
  data,
  { instancePath = "", parentData, parentDataProperty, rootData = data } = {},
) {
  let vErrors = null;
  let errors = 0;
  if (!(
    typeof data == "number" &&
    !(data % 1) &&
    !isNaN(data) &&
    isFinite(data)
  )) {
    const err0 = {
      instancePath,
      schemaPath: "#/type",
      keyword: "type",
      params: { type: "integer" },
      message: "must be integer",
    };
    if (vErrors === null) {
      vErrors = [err0];
    } else {
      vErrors.push(err0);
    }
    errors++;
  }
  if (typeof data == "number" && isFinite(data)) {
    if (data > 9007199254740991 || isNaN(data)) {
      const err1 = {
        instancePath,
        schemaPath: "#/maximum",
        keyword: "maximum",
        params: { comparison: "<=", limit: 9007199254740991 },
        message: "must be <= 9007199254740991",
      };
      if (vErrors === null) {
        vErrors = [err1];
      } else {
        vErrors.push(err1);
      }
      errors++;
    }
    if (data < -9007199254740991 || isNaN(data)) {
      const err2 = {
        instancePath,
        schemaPath: "#/minimum",
        keyword: "minimum",
        params: { comparison: ">=", limit: -9007199254740991 },
        message: "must be >= -9007199254740991",
      };
      if (vErrors === null) {
        vErrors = [err2];
      } else {
        vErrors.push(err2);
      }
      errors++;
    }
  }
  validate53.errors = vErrors;
  return errors === 0;
}
var wrapper2 = { validate: validate52 };
function validate52(
  data,
  { instancePath = "", parentData, parentDataProperty, rootData = data } = {},
) {
  let vErrors = null;
  let errors = 0;
  const _errs0 = errors;
  let valid0 = false;
  const _errs1 = errors;
  if (data !== null) {
    const err0 = {
      instancePath,
      schemaPath: "#/anyOf/0/type",
      keyword: "type",
      params: { type: "null" },
      message: "must be null",
    };
    if (vErrors === null) {
      vErrors = [err0];
    } else {
      vErrors.push(err0);
    }
    errors++;
  }
  var _valid0 = _errs1 === errors;
  valid0 = valid0 || _valid0;
  if (!valid0) {
    const _errs3 = errors;
    if (typeof data !== "boolean") {
      const err1 = {
        instancePath,
        schemaPath: "#/anyOf/1/type",
        keyword: "type",
        params: { type: "boolean" },
        message: "must be boolean",
      };
      if (vErrors === null) {
        vErrors = [err1];
      } else {
        vErrors.push(err1);
      }
      errors++;
    }
    var _valid0 = _errs3 === errors;
    valid0 = valid0 || _valid0;
    if (!valid0) {
      const _errs5 = errors;
      if (
        !validate53(data, {
          instancePath,
          parentData,
          parentDataProperty,
          rootData,
        })
      ) {
        vErrors =
          vErrors === null
            ? validate53.errors
            : vErrors.concat(validate53.errors);
        errors = vErrors.length;
      }
      var _valid0 = _errs5 === errors;
      valid0 = valid0 || _valid0;
      if (!valid0) {
        const _errs6 = errors;
        if (typeof data !== "string") {
          const err2 = {
            instancePath,
            schemaPath: "#/anyOf/3/type",
            keyword: "type",
            params: { type: "string" },
            message: "must be string",
          };
          if (vErrors === null) {
            vErrors = [err2];
          } else {
            vErrors.push(err2);
          }
          errors++;
        }
        var _valid0 = _errs6 === errors;
        valid0 = valid0 || _valid0;
        if (!valid0) {
          const _errs8 = errors;
          if (Array.isArray(data)) {
            const len0 = data.length;
            for (let i0 = 0; i0 < len0; i0++) {
              if (
                !wrapper2.validate(data[i0], {
                  instancePath: instancePath + "/" + i0,
                  parentData: data,
                  parentDataProperty: i0,
                  rootData,
                })
              ) {
                vErrors =
                  vErrors === null
                    ? wrapper2.validate.errors
                    : vErrors.concat(wrapper2.validate.errors);
                errors = vErrors.length;
              }
            }
          } else {
            const err3 = {
              instancePath,
              schemaPath: "#/anyOf/4/type",
              keyword: "type",
              params: { type: "array" },
              message: "must be array",
            };
            if (vErrors === null) {
              vErrors = [err3];
            } else {
              vErrors.push(err3);
            }
            errors++;
          }
          var _valid0 = _errs8 === errors;
          valid0 = valid0 || _valid0;
          if (!valid0) {
            const _errs11 = errors;
            if (data && typeof data == "object" && !Array.isArray(data)) {
              for (const key0 of Object.keys(data)) {
                if (
                  !wrapper2.validate(data[key0], {
                    instancePath:
                      instancePath +
                      "/" +
                      key0.replace(/~/g, "~0").replace(/\//g, "~1"),
                    parentData: data,
                    parentDataProperty: key0,
                    rootData,
                  })
                ) {
                  vErrors =
                    vErrors === null
                      ? wrapper2.validate.errors
                      : vErrors.concat(wrapper2.validate.errors);
                  errors = vErrors.length;
                }
              }
            } else {
              const err4 = {
                instancePath,
                schemaPath: "#/anyOf/5/type",
                keyword: "type",
                params: { type: "object" },
                message: "must be object",
              };
              if (vErrors === null) {
                vErrors = [err4];
              } else {
                vErrors.push(err4);
              }
              errors++;
            }
            var _valid0 = _errs11 === errors;
            valid0 = valid0 || _valid0;
          }
        }
      }
    }
  }
  if (!valid0) {
    const err5 = {
      instancePath,
      schemaPath: "#/anyOf",
      keyword: "anyOf",
      params: {},
      message: "must match a schema in anyOf",
    };
    if (vErrors === null) {
      vErrors = [err5];
    } else {
      vErrors.push(err5);
    }
    errors++;
  } else {
    errors = _errs0;
    if (vErrors !== null) {
      if (_errs0) {
        vErrors.length = _errs0;
      } else {
        vErrors = null;
      }
    }
  }
  validate52.errors = vErrors;
  return errors === 0;
}
var pattern3 = new RegExp(
  "^(?:host|device|session|operation|workspace|settings|capture|capture_record|plugin_result|transfer_receipts|file|plugin|client|[A-Za-z0-9._-]+:[A-Za-z0-9._-]+)$",
  "u",
);
function validate63(
  data,
  { instancePath = "", parentData, parentDataProperty, rootData = data } = {},
) {
  let vErrors = null;
  let errors = 0;
  if (typeof data === "string") {
    if (!pattern3.test(data)) {
      const err0 = {
        instancePath,
        schemaPath: "#/pattern",
        keyword: "pattern",
        params: {
          pattern:
            "^(?:host|device|session|operation|workspace|settings|capture|capture_record|plugin_result|transfer_receipts|file|plugin|client|[A-Za-z0-9._-]+:[A-Za-z0-9._-]+)$",
        },
        message:
          'must match pattern "^(?:host|device|session|operation|workspace|settings|capture|capture_record|plugin_result|transfer_receipts|file|plugin|client|[A-Za-z0-9._-]+:[A-Za-z0-9._-]+)$"',
      };
      if (vErrors === null) {
        vErrors = [err0];
      } else {
        vErrors.push(err0);
      }
      errors++;
    }
  } else {
    const err1 = {
      instancePath,
      schemaPath: "#/type",
      keyword: "type",
      params: { type: "string" },
      message: "must be string",
    };
    if (vErrors === null) {
      vErrors = [err1];
    } else {
      vErrors.push(err1);
    }
    errors++;
  }
  validate63.errors = vErrors;
  return errors === 0;
}
function validate60(
  data,
  { instancePath = "", parentData, parentDataProperty, rootData = data } = {},
) {
  let vErrors = null;
  let errors = 0;
  if (data && typeof data == "object" && !Array.isArray(data)) {
    if (data.hostId === void 0 || !func0.call(data, "hostId")) {
      const err0 = {
        instancePath,
        schemaPath: "#/required",
        keyword: "required",
        params: { missingProperty: "hostId" },
        message: "must have required property 'hostId'",
      };
      if (vErrors === null) {
        vErrors = [err0];
      } else {
        vErrors.push(err0);
      }
      errors++;
    }
    if (data.kind === void 0 || !func0.call(data, "kind")) {
      const err1 = {
        instancePath,
        schemaPath: "#/required",
        keyword: "required",
        params: { missingProperty: "kind" },
        message: "must have required property 'kind'",
      };
      if (vErrors === null) {
        vErrors = [err1];
      } else {
        vErrors.push(err1);
      }
      errors++;
    }
    if (data.id === void 0 || !func0.call(data, "id")) {
      const err2 = {
        instancePath,
        schemaPath: "#/required",
        keyword: "required",
        params: { missingProperty: "id" },
        message: "must have required property 'id'",
      };
      if (vErrors === null) {
        vErrors = [err2];
      } else {
        vErrors.push(err2);
      }
      errors++;
    }
    for (const key0 of Object.keys(data)) {
      if (!(
        key0 === "hostId" ||
        key0 === "id" ||
        key0 === "kind" ||
        key0 === "revision"
      )) {
        const err3 = {
          instancePath,
          schemaPath: "#/additionalProperties",
          keyword: "additionalProperties",
          params: { additionalProperty: key0 },
          message: "must NOT have additional properties",
        };
        if (vErrors === null) {
          vErrors = [err3];
        } else {
          vErrors.push(err3);
        }
        errors++;
      }
    }
    if (data.hostId !== void 0 && func0.call(data, "hostId")) {
      if (
        !validate26(data.hostId, {
          instancePath: instancePath + "/hostId",
          parentData: data,
          parentDataProperty: "hostId",
          rootData,
        })
      ) {
        vErrors =
          vErrors === null
            ? validate26.errors
            : vErrors.concat(validate26.errors);
        errors = vErrors.length;
      }
    }
    if (data.id !== void 0 && func0.call(data, "id")) {
      if (
        !validate26(data.id, {
          instancePath: instancePath + "/id",
          parentData: data,
          parentDataProperty: "id",
          rootData,
        })
      ) {
        vErrors =
          vErrors === null
            ? validate26.errors
            : vErrors.concat(validate26.errors);
        errors = vErrors.length;
      }
    }
    if (data.kind !== void 0 && func0.call(data, "kind")) {
      if (
        !validate63(data.kind, {
          instancePath: instancePath + "/kind",
          parentData: data,
          parentDataProperty: "kind",
          rootData,
        })
      ) {
        vErrors =
          vErrors === null
            ? validate63.errors
            : vErrors.concat(validate63.errors);
        errors = vErrors.length;
      }
    }
    if (data.revision !== void 0 && func0.call(data, "revision")) {
      if (
        !validate23(data.revision, {
          instancePath: instancePath + "/revision",
          parentData: data,
          parentDataProperty: "revision",
          rootData,
        })
      ) {
        vErrors =
          vErrors === null
            ? validate23.errors
            : vErrors.concat(validate23.errors);
        errors = vErrors.length;
      }
    }
  } else {
    const err4 = {
      instancePath,
      schemaPath: "#/type",
      keyword: "type",
      params: { type: "object" },
      message: "must be object",
    };
    if (vErrors === null) {
      vErrors = [err4];
    } else {
      vErrors.push(err4);
    }
    errors++;
  }
  validate60.errors = vErrors;
  return errors === 0;
}
function validate57(
  data,
  { instancePath = "", parentData, parentDataProperty, rootData = data } = {},
) {
  let vErrors = null;
  let errors = 0;
  if (data && typeof data == "object" && !Array.isArray(data)) {
    if (data.pageId === void 0 || !func0.call(data, "pageId")) {
      const err0 = {
        instancePath,
        schemaPath: "#/required",
        keyword: "required",
        params: { missingProperty: "pageId" },
        message: "must have required property 'pageId'",
      };
      if (vErrors === null) {
        vErrors = [err0];
      } else {
        vErrors.push(err0);
      }
      errors++;
    }
    for (const key0 of Object.keys(data)) {
      if (!(
        key0 === "pageId" ||
        key0 === "panelId" ||
        key0 === "resultRef" ||
        key0 === "sessionId" ||
        key0 === "workspaceId"
      )) {
        const err1 = {
          instancePath,
          schemaPath: "#/additionalProperties",
          keyword: "additionalProperties",
          params: { additionalProperty: key0 },
          message: "must NOT have additional properties",
        };
        if (vErrors === null) {
          vErrors = [err1];
        } else {
          vErrors.push(err1);
        }
        errors++;
      }
    }
    if (data.pageId !== void 0 && func0.call(data, "pageId")) {
      if (
        !validate26(data.pageId, {
          instancePath: instancePath + "/pageId",
          parentData: data,
          parentDataProperty: "pageId",
          rootData,
        })
      ) {
        vErrors =
          vErrors === null
            ? validate26.errors
            : vErrors.concat(validate26.errors);
        errors = vErrors.length;
      }
    }
    if (data.panelId !== void 0 && func0.call(data, "panelId")) {
      if (
        !validate26(data.panelId, {
          instancePath: instancePath + "/panelId",
          parentData: data,
          parentDataProperty: "panelId",
          rootData,
        })
      ) {
        vErrors =
          vErrors === null
            ? validate26.errors
            : vErrors.concat(validate26.errors);
        errors = vErrors.length;
      }
    }
    if (data.resultRef !== void 0 && func0.call(data, "resultRef")) {
      if (
        !validate60(data.resultRef, {
          instancePath: instancePath + "/resultRef",
          parentData: data,
          parentDataProperty: "resultRef",
          rootData,
        })
      ) {
        vErrors =
          vErrors === null
            ? validate60.errors
            : vErrors.concat(validate60.errors);
        errors = vErrors.length;
      }
    }
    if (data.sessionId !== void 0 && func0.call(data, "sessionId")) {
      if (
        !validate26(data.sessionId, {
          instancePath: instancePath + "/sessionId",
          parentData: data,
          parentDataProperty: "sessionId",
          rootData,
        })
      ) {
        vErrors =
          vErrors === null
            ? validate26.errors
            : vErrors.concat(validate26.errors);
        errors = vErrors.length;
      }
    }
    if (data.workspaceId !== void 0 && func0.call(data, "workspaceId")) {
      if (
        !validate26(data.workspaceId, {
          instancePath: instancePath + "/workspaceId",
          parentData: data,
          parentDataProperty: "workspaceId",
          rootData,
        })
      ) {
        vErrors =
          vErrors === null
            ? validate26.errors
            : vErrors.concat(validate26.errors);
        errors = vErrors.length;
      }
    }
  } else {
    const err2 = {
      instancePath,
      schemaPath: "#/type",
      keyword: "type",
      params: { type: "object" },
      message: "must be object",
    };
    if (vErrors === null) {
      vErrors = [err2];
    } else {
      vErrors.push(err2);
    }
    errors++;
  }
  validate57.errors = vErrors;
  return errors === 0;
}
function validate51(
  data,
  { instancePath = "", parentData, parentDataProperty, rootData = data } = {},
) {
  let vErrors = null;
  let errors = 0;
  if (data && typeof data == "object" && !Array.isArray(data)) {
    if (data.code === void 0 || !func0.call(data, "code")) {
      const err0 = {
        instancePath,
        schemaPath: "#/required",
        keyword: "required",
        params: { missingProperty: "code" },
        message: "must have required property 'code'",
      };
      if (vErrors === null) {
        vErrors = [err0];
      } else {
        vErrors.push(err0);
      }
      errors++;
    }
    if (data.message === void 0 || !func0.call(data, "message")) {
      const err1 = {
        instancePath,
        schemaPath: "#/required",
        keyword: "required",
        params: { missingProperty: "message" },
        message: "must have required property 'message'",
      };
      if (vErrors === null) {
        vErrors = [err1];
      } else {
        vErrors.push(err1);
      }
      errors++;
    }
    if (data.retryable === void 0 || !func0.call(data, "retryable")) {
      const err2 = {
        instancePath,
        schemaPath: "#/required",
        keyword: "required",
        params: { missingProperty: "retryable" },
        message: "must have required property 'retryable'",
      };
      if (vErrors === null) {
        vErrors = [err2];
      } else {
        vErrors.push(err2);
      }
      errors++;
    }
    for (const key0 of Object.keys(data)) {
      if (!(
        key0 === "code" ||
        key0 === "details" ||
        key0 === "message" ||
        key0 === "operationId" ||
        key0 === "retryable" ||
        key0 === "revealTarget"
      )) {
        const err3 = {
          instancePath,
          schemaPath: "#/additionalProperties",
          keyword: "additionalProperties",
          params: { additionalProperty: key0 },
          message: "must NOT have additional properties",
        };
        if (vErrors === null) {
          vErrors = [err3];
        } else {
          vErrors.push(err3);
        }
        errors++;
      }
    }
    if (data.code !== void 0 && func0.call(data, "code")) {
      if (typeof data.code !== "string") {
        const err4 = {
          instancePath: instancePath + "/code",
          schemaPath: "#/properties/code/type",
          keyword: "type",
          params: { type: "string" },
          message: "must be string",
        };
        if (vErrors === null) {
          vErrors = [err4];
        } else {
          vErrors.push(err4);
        }
        errors++;
      }
    }
    if (data.details !== void 0 && func0.call(data, "details")) {
      let data1 = data.details;
      if (data1 && typeof data1 == "object" && !Array.isArray(data1)) {
        for (const key1 of Object.keys(data1)) {
          if (
            !validate52(data1[key1], {
              instancePath:
                instancePath +
                "/details/" +
                key1.replace(/~/g, "~0").replace(/\//g, "~1"),
              parentData: data1,
              parentDataProperty: key1,
              rootData,
            })
          ) {
            vErrors =
              vErrors === null
                ? validate52.errors
                : vErrors.concat(validate52.errors);
            errors = vErrors.length;
          }
        }
      } else {
        const err5 = {
          instancePath: instancePath + "/details",
          schemaPath: "#/properties/details/type",
          keyword: "type",
          params: { type: "object" },
          message: "must be object",
        };
        if (vErrors === null) {
          vErrors = [err5];
        } else {
          vErrors.push(err5);
        }
        errors++;
      }
    }
    if (data.message !== void 0 && func0.call(data, "message")) {
      if (typeof data.message !== "string") {
        const err6 = {
          instancePath: instancePath + "/message",
          schemaPath: "#/properties/message/type",
          keyword: "type",
          params: { type: "string" },
          message: "must be string",
        };
        if (vErrors === null) {
          vErrors = [err6];
        } else {
          vErrors.push(err6);
        }
        errors++;
      }
    }
    if (data.operationId !== void 0 && func0.call(data, "operationId")) {
      if (
        !validate26(data.operationId, {
          instancePath: instancePath + "/operationId",
          parentData: data,
          parentDataProperty: "operationId",
          rootData,
        })
      ) {
        vErrors =
          vErrors === null
            ? validate26.errors
            : vErrors.concat(validate26.errors);
        errors = vErrors.length;
      }
    }
    if (data.retryable !== void 0 && func0.call(data, "retryable")) {
      if (typeof data.retryable !== "boolean") {
        const err7 = {
          instancePath: instancePath + "/retryable",
          schemaPath: "#/properties/retryable/type",
          keyword: "type",
          params: { type: "boolean" },
          message: "must be boolean",
        };
        if (vErrors === null) {
          vErrors = [err7];
        } else {
          vErrors.push(err7);
        }
        errors++;
      }
    }
    if (data.revealTarget !== void 0 && func0.call(data, "revealTarget")) {
      if (
        !validate57(data.revealTarget, {
          instancePath: instancePath + "/revealTarget",
          parentData: data,
          parentDataProperty: "revealTarget",
          rootData,
        })
      ) {
        vErrors =
          vErrors === null
            ? validate57.errors
            : vErrors.concat(validate57.errors);
        errors = vErrors.length;
      }
    }
  } else {
    const err8 = {
      instancePath,
      schemaPath: "#/type",
      keyword: "type",
      params: { type: "object" },
      message: "must be object",
    };
    if (vErrors === null) {
      vErrors = [err8];
    } else {
      vErrors.push(err8);
    }
    errors++;
  }
  validate51.errors = vErrors;
  return errors === 0;
}
var validateRawBatch = validate70;
function validate71(
  data,
  { instancePath = "", parentData, parentDataProperty, rootData = data } = {},
) {
  let vErrors = null;
  let errors = 0;
  if (data && typeof data == "object" && !Array.isArray(data)) {
    if (data.hostId === void 0 || !func0.call(data, "hostId")) {
      const err0 = {
        instancePath,
        schemaPath: "#/required",
        keyword: "required",
        params: { missingProperty: "hostId" },
        message: "must have required property 'hostId'",
      };
      if (vErrors === null) {
        vErrors = [err0];
      } else {
        vErrors.push(err0);
      }
      errors++;
    }
    if (data.instanceEpoch === void 0 || !func0.call(data, "instanceEpoch")) {
      const err1 = {
        instancePath,
        schemaPath: "#/required",
        keyword: "required",
        params: { missingProperty: "instanceEpoch" },
        message: "must have required property 'instanceEpoch'",
      };
      if (vErrors === null) {
        vErrors = [err1];
      } else {
        vErrors.push(err1);
      }
      errors++;
    }
    if (data.scopeId === void 0 || !func0.call(data, "scopeId")) {
      const err2 = {
        instancePath,
        schemaPath: "#/required",
        keyword: "required",
        params: { missingProperty: "scopeId" },
        message: "must have required property 'scopeId'",
      };
      if (vErrors === null) {
        vErrors = [err2];
      } else {
        vErrors.push(err2);
      }
      errors++;
    }
    if (data.position === void 0 || !func0.call(data, "position")) {
      const err3 = {
        instancePath,
        schemaPath: "#/required",
        keyword: "required",
        params: { missingProperty: "position" },
        message: "must have required property 'position'",
      };
      if (vErrors === null) {
        vErrors = [err3];
      } else {
        vErrors.push(err3);
      }
      errors++;
    }
    for (const key0 of Object.keys(data)) {
      if (!(
        key0 === "hostId" ||
        key0 === "instanceEpoch" ||
        key0 === "position" ||
        key0 === "scopeId"
      )) {
        const err4 = {
          instancePath,
          schemaPath: "#/additionalProperties",
          keyword: "additionalProperties",
          params: { additionalProperty: key0 },
          message: "must NOT have additional properties",
        };
        if (vErrors === null) {
          vErrors = [err4];
        } else {
          vErrors.push(err4);
        }
        errors++;
      }
    }
    if (data.hostId !== void 0 && func0.call(data, "hostId")) {
      if (
        !validate26(data.hostId, {
          instancePath: instancePath + "/hostId",
          parentData: data,
          parentDataProperty: "hostId",
          rootData,
        })
      ) {
        vErrors =
          vErrors === null
            ? validate26.errors
            : vErrors.concat(validate26.errors);
        errors = vErrors.length;
      }
    }
    if (data.instanceEpoch !== void 0 && func0.call(data, "instanceEpoch")) {
      if (
        !validate23(data.instanceEpoch, {
          instancePath: instancePath + "/instanceEpoch",
          parentData: data,
          parentDataProperty: "instanceEpoch",
          rootData,
        })
      ) {
        vErrors =
          vErrors === null
            ? validate23.errors
            : vErrors.concat(validate23.errors);
        errors = vErrors.length;
      }
    }
    if (data.position !== void 0 && func0.call(data, "position")) {
      if (
        !validate23(data.position, {
          instancePath: instancePath + "/position",
          parentData: data,
          parentDataProperty: "position",
          rootData,
        })
      ) {
        vErrors =
          vErrors === null
            ? validate23.errors
            : vErrors.concat(validate23.errors);
        errors = vErrors.length;
      }
    }
    if (data.scopeId !== void 0 && func0.call(data, "scopeId")) {
      if (
        !validate26(data.scopeId, {
          instancePath: instancePath + "/scopeId",
          parentData: data,
          parentDataProperty: "scopeId",
          rootData,
        })
      ) {
        vErrors =
          vErrors === null
            ? validate26.errors
            : vErrors.concat(validate26.errors);
        errors = vErrors.length;
      }
    }
  } else {
    const err5 = {
      instancePath,
      schemaPath: "#/type",
      keyword: "type",
      params: { type: "object" },
      message: "must be object",
    };
    if (vErrors === null) {
      vErrors = [err5];
    } else {
      vErrors.push(err5);
    }
    errors++;
  }
  validate71.errors = vErrors;
  return errors === 0;
}
var schema26 = {
  additionalProperties: false,
  oneOf: [
    {
      properties: {
        kind: { const: "rx", type: "string" },
        payload: { $ref: "#/definitions/shared/definitions/RxPayload" },
      },
      required: ["kind", "payload"],
      type: "object",
    },
    {
      properties: {
        kind: { const: "tx_intent", type: "string" },
        payload: { $ref: "#/definitions/shared/definitions/TxIntent" },
      },
      required: ["kind", "payload"],
      type: "object",
    },
    {
      properties: {
        kind: { const: "tx", type: "string" },
        payload: { $ref: "#/definitions/shared/definitions/TxReceipt" },
      },
      required: ["kind", "payload"],
      type: "object",
    },
    {
      properties: {
        kind: { const: "gap", type: "string" },
        payload: { $ref: "#/definitions/shared/definitions/SourceGap" },
      },
      required: ["kind", "payload"],
      type: "object",
    },
    {
      properties: {
        kind: { const: "configuration_boundary", type: "string" },
        payload: {
          $ref: "#/definitions/shared/definitions/ConfigurationBoundary",
        },
      },
      required: ["kind", "payload"],
      type: "object",
    },
    {
      properties: {
        kind: { const: "lifecycle", type: "string" },
        payload: {
          additionalProperties: {
            $ref: "#/definitions/shared/definitions/JsonValue",
          },
          type: "object",
        },
      },
      required: ["kind", "payload"],
      type: "object",
    },
    {
      properties: {
        kind: { const: "control", type: "string" },
        payload: {
          additionalProperties: {
            $ref: "#/definitions/shared/definitions/JsonValue",
          },
          type: "object",
        },
      },
      required: ["kind", "payload"],
      type: "object",
    },
  ],
  properties: {
    configurationRevision: { $ref: "#/definitions/shared/definitions/U64" },
    eventSeq: { $ref: "#/definitions/shared/definitions/U64" },
    hostId: { $ref: "#/definitions/shared/definitions/Id" },
    instanceEpoch: { $ref: "#/definitions/shared/definitions/U64" },
    kind: true,
    payload: true,
    sessionEpoch: { $ref: "#/definitions/shared/definitions/U64" },
    sessionId: { $ref: "#/definitions/shared/definitions/Id" },
    time: { $ref: "#/definitions/shared/definitions/EventTime" },
  },
  required: [
    "hostId",
    "instanceEpoch",
    "sessionId",
    "sessionEpoch",
    "eventSeq",
    "configurationRevision",
    "time",
  ],
  type: "object",
};
var pattern4 = new RegExp(
  "^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/][AQgw]==|[A-Za-z0-9+/]{2}[AEIMQUYcgkosw048]=)?$",
  "u",
);
function validate82(
  data,
  { instancePath = "", parentData, parentDataProperty, rootData = data } = {},
) {
  let vErrors = null;
  let errors = 0;
  if (typeof data === "string") {
    if (!pattern4.test(data)) {
      const err0 = {
        instancePath,
        schemaPath: "#/pattern",
        keyword: "pattern",
        params: {
          pattern:
            "^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/][AQgw]==|[A-Za-z0-9+/]{2}[AEIMQUYcgkosw048]=)?$",
        },
        message:
          'must match pattern "^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/][AQgw]==|[A-Za-z0-9+/]{2}[AEIMQUYcgkosw048]=)?$"',
      };
      if (vErrors === null) {
        vErrors = [err0];
      } else {
        vErrors.push(err0);
      }
      errors++;
    }
  } else {
    const err1 = {
      instancePath,
      schemaPath: "#/type",
      keyword: "type",
      params: { type: "string" },
      message: "must be string",
    };
    if (vErrors === null) {
      vErrors = [err1];
    } else {
      vErrors.push(err1);
    }
    errors++;
  }
  validate82.errors = vErrors;
  return errors === 0;
}
function validate84(
  data,
  { instancePath = "", parentData, parentDataProperty, rootData = data } = {},
) {
  let vErrors = null;
  let errors = 0;
  if (data && typeof data == "object" && !Array.isArray(data)) {
    if (data.messageId === void 0 || !func0.call(data, "messageId")) {
      const err0 = {
        instancePath,
        schemaPath: "#/required",
        keyword: "required",
        params: { missingProperty: "messageId" },
        message: "must have required property 'messageId'",
      };
      if (vErrors === null) {
        vErrors = [err0];
      } else {
        vErrors.push(err0);
      }
      errors++;
    }
    if (data.fragmentOffset === void 0 || !func0.call(data, "fragmentOffset")) {
      const err1 = {
        instancePath,
        schemaPath: "#/required",
        keyword: "required",
        params: { missingProperty: "fragmentOffset" },
        message: "must have required property 'fragmentOffset'",
      };
      if (vErrors === null) {
        vErrors = [err1];
      } else {
        vErrors.push(err1);
      }
      errors++;
    }
    if (data.messageLength === void 0 || !func0.call(data, "messageLength")) {
      const err2 = {
        instancePath,
        schemaPath: "#/required",
        keyword: "required",
        params: { missingProperty: "messageLength" },
        message: "must have required property 'messageLength'",
      };
      if (vErrors === null) {
        vErrors = [err2];
      } else {
        vErrors.push(err2);
      }
      errors++;
    }
    if (data.messageType === void 0 || !func0.call(data, "messageType")) {
      const err3 = {
        instancePath,
        schemaPath: "#/required",
        keyword: "required",
        params: { missingProperty: "messageType" },
        message: "must have required property 'messageType'",
      };
      if (vErrors === null) {
        vErrors = [err3];
      } else {
        vErrors.push(err3);
      }
      errors++;
    }
    for (const key0 of Object.keys(data)) {
      if (!(
        key0 === "fragmentOffset" ||
        key0 === "messageId" ||
        key0 === "messageLength" ||
        key0 === "messageType"
      )) {
        const err4 = {
          instancePath,
          schemaPath: "#/additionalProperties",
          keyword: "additionalProperties",
          params: { additionalProperty: key0 },
          message: "must NOT have additional properties",
        };
        if (vErrors === null) {
          vErrors = [err4];
        } else {
          vErrors.push(err4);
        }
        errors++;
      }
    }
    if (data.fragmentOffset !== void 0 && func0.call(data, "fragmentOffset")) {
      if (
        !validate23(data.fragmentOffset, {
          instancePath: instancePath + "/fragmentOffset",
          parentData: data,
          parentDataProperty: "fragmentOffset",
          rootData,
        })
      ) {
        vErrors =
          vErrors === null
            ? validate23.errors
            : vErrors.concat(validate23.errors);
        errors = vErrors.length;
      }
    }
    if (data.messageId !== void 0 && func0.call(data, "messageId")) {
      if (
        !validate26(data.messageId, {
          instancePath: instancePath + "/messageId",
          parentData: data,
          parentDataProperty: "messageId",
          rootData,
        })
      ) {
        vErrors =
          vErrors === null
            ? validate26.errors
            : vErrors.concat(validate26.errors);
        errors = vErrors.length;
      }
    }
    if (data.messageLength !== void 0 && func0.call(data, "messageLength")) {
      if (
        !validate23(data.messageLength, {
          instancePath: instancePath + "/messageLength",
          parentData: data,
          parentDataProperty: "messageLength",
          rootData,
        })
      ) {
        vErrors =
          vErrors === null
            ? validate23.errors
            : vErrors.concat(validate23.errors);
        errors = vErrors.length;
      }
    }
    if (data.messageType !== void 0 && func0.call(data, "messageType")) {
      if (typeof data.messageType !== "string") {
        const err5 = {
          instancePath: instancePath + "/messageType",
          schemaPath: "#/properties/messageType/type",
          keyword: "type",
          params: { type: "string" },
          message: "must be string",
        };
        if (vErrors === null) {
          vErrors = [err5];
        } else {
          vErrors.push(err5);
        }
        errors++;
      }
    }
  } else {
    const err6 = {
      instancePath,
      schemaPath: "#/type",
      keyword: "type",
      params: { type: "object" },
      message: "must be object",
    };
    if (vErrors === null) {
      vErrors = [err6];
    } else {
      vErrors.push(err6);
    }
    errors++;
  }
  validate84.errors = vErrors;
  return errors === 0;
}
function validate79(
  data,
  { instancePath = "", parentData, parentDataProperty, rootData = data } = {},
) {
  let vErrors = null;
  let errors = 0;
  if (data && typeof data == "object" && !Array.isArray(data)) {
    if (data.bytesBase64 === void 0 || !func0.call(data, "bytesBase64")) {
      const err0 = {
        instancePath,
        schemaPath: "#/required",
        keyword: "required",
        params: { missingProperty: "bytesBase64" },
        message: "must have required property 'bytesBase64'",
      };
      if (vErrors === null) {
        vErrors = [err0];
      } else {
        vErrors.push(err0);
      }
      errors++;
    }
    if (data.byteStart === void 0 || !func0.call(data, "byteStart")) {
      const err1 = {
        instancePath,
        schemaPath: "#/required",
        keyword: "required",
        params: { missingProperty: "byteStart" },
        message: "must have required property 'byteStart'",
      };
      if (vErrors === null) {
        vErrors = [err1];
      } else {
        vErrors.push(err1);
      }
      errors++;
    }
    if (data.byteEnd === void 0 || !func0.call(data, "byteEnd")) {
      const err2 = {
        instancePath,
        schemaPath: "#/required",
        keyword: "required",
        params: { missingProperty: "byteEnd" },
        message: "must have required property 'byteEnd'",
      };
      if (vErrors === null) {
        vErrors = [err2];
      } else {
        vErrors.push(err2);
      }
      errors++;
    }
    for (const key0 of Object.keys(data)) {
      if (!(
        key0 === "byteEnd" ||
        key0 === "byteStart" ||
        key0 === "bytesBase64" ||
        key0 === "message"
      )) {
        const err3 = {
          instancePath,
          schemaPath: "#/additionalProperties",
          keyword: "additionalProperties",
          params: { additionalProperty: key0 },
          message: "must NOT have additional properties",
        };
        if (vErrors === null) {
          vErrors = [err3];
        } else {
          vErrors.push(err3);
        }
        errors++;
      }
    }
    if (data.byteEnd !== void 0 && func0.call(data, "byteEnd")) {
      if (
        !validate23(data.byteEnd, {
          instancePath: instancePath + "/byteEnd",
          parentData: data,
          parentDataProperty: "byteEnd",
          rootData,
        })
      ) {
        vErrors =
          vErrors === null
            ? validate23.errors
            : vErrors.concat(validate23.errors);
        errors = vErrors.length;
      }
    }
    if (data.byteStart !== void 0 && func0.call(data, "byteStart")) {
      if (
        !validate23(data.byteStart, {
          instancePath: instancePath + "/byteStart",
          parentData: data,
          parentDataProperty: "byteStart",
          rootData,
        })
      ) {
        vErrors =
          vErrors === null
            ? validate23.errors
            : vErrors.concat(validate23.errors);
        errors = vErrors.length;
      }
    }
    if (data.bytesBase64 !== void 0 && func0.call(data, "bytesBase64")) {
      if (
        !validate82(data.bytesBase64, {
          instancePath: instancePath + "/bytesBase64",
          parentData: data,
          parentDataProperty: "bytesBase64",
          rootData,
        })
      ) {
        vErrors =
          vErrors === null
            ? validate82.errors
            : vErrors.concat(validate82.errors);
        errors = vErrors.length;
      }
    }
    if (data.message !== void 0 && func0.call(data, "message")) {
      if (
        !validate84(data.message, {
          instancePath: instancePath + "/message",
          parentData: data,
          parentDataProperty: "message",
          rootData,
        })
      ) {
        vErrors =
          vErrors === null
            ? validate84.errors
            : vErrors.concat(validate84.errors);
        errors = vErrors.length;
      }
    }
  } else {
    const err4 = {
      instancePath,
      schemaPath: "#/type",
      keyword: "type",
      params: { type: "object" },
      message: "must be object",
    };
    if (vErrors === null) {
      vErrors = [err4];
    } else {
      vErrors.push(err4);
    }
    errors++;
  }
  validate79.errors = vErrors;
  return errors === 0;
}
function validate90(
  data,
  { instancePath = "", parentData, parentDataProperty, rootData = data } = {},
) {
  let vErrors = null;
  let errors = 0;
  if (data && typeof data == "object" && !Array.isArray(data)) {
    if (data.operationId === void 0 || !func0.call(data, "operationId")) {
      const err0 = {
        instancePath,
        schemaPath: "#/required",
        keyword: "required",
        params: { missingProperty: "operationId" },
        message: "must have required property 'operationId'",
      };
      if (vErrors === null) {
        vErrors = [err0];
      } else {
        vErrors.push(err0);
      }
      errors++;
    }
    if (data.bytesBase64 === void 0 || !func0.call(data, "bytesBase64")) {
      const err1 = {
        instancePath,
        schemaPath: "#/required",
        keyword: "required",
        params: { missingProperty: "bytesBase64" },
        message: "must have required property 'bytesBase64'",
      };
      if (vErrors === null) {
        vErrors = [err1];
      } else {
        vErrors.push(err1);
      }
      errors++;
    }
    if (data.byteStart === void 0 || !func0.call(data, "byteStart")) {
      const err2 = {
        instancePath,
        schemaPath: "#/required",
        keyword: "required",
        params: { missingProperty: "byteStart" },
        message: "must have required property 'byteStart'",
      };
      if (vErrors === null) {
        vErrors = [err2];
      } else {
        vErrors.push(err2);
      }
      errors++;
    }
    if (data.byteEnd === void 0 || !func0.call(data, "byteEnd")) {
      const err3 = {
        instancePath,
        schemaPath: "#/required",
        keyword: "required",
        params: { missingProperty: "byteEnd" },
        message: "must have required property 'byteEnd'",
      };
      if (vErrors === null) {
        vErrors = [err3];
      } else {
        vErrors.push(err3);
      }
      errors++;
    }
    for (const key0 of Object.keys(data)) {
      if (!(
        key0 === "byteEnd" ||
        key0 === "byteStart" ||
        key0 === "bytesBase64" ||
        key0 === "operationId"
      )) {
        const err4 = {
          instancePath,
          schemaPath: "#/additionalProperties",
          keyword: "additionalProperties",
          params: { additionalProperty: key0 },
          message: "must NOT have additional properties",
        };
        if (vErrors === null) {
          vErrors = [err4];
        } else {
          vErrors.push(err4);
        }
        errors++;
      }
    }
    if (data.byteEnd !== void 0 && func0.call(data, "byteEnd")) {
      if (
        !validate23(data.byteEnd, {
          instancePath: instancePath + "/byteEnd",
          parentData: data,
          parentDataProperty: "byteEnd",
          rootData,
        })
      ) {
        vErrors =
          vErrors === null
            ? validate23.errors
            : vErrors.concat(validate23.errors);
        errors = vErrors.length;
      }
    }
    if (data.byteStart !== void 0 && func0.call(data, "byteStart")) {
      if (
        !validate23(data.byteStart, {
          instancePath: instancePath + "/byteStart",
          parentData: data,
          parentDataProperty: "byteStart",
          rootData,
        })
      ) {
        vErrors =
          vErrors === null
            ? validate23.errors
            : vErrors.concat(validate23.errors);
        errors = vErrors.length;
      }
    }
    if (data.bytesBase64 !== void 0 && func0.call(data, "bytesBase64")) {
      if (
        !validate82(data.bytesBase64, {
          instancePath: instancePath + "/bytesBase64",
          parentData: data,
          parentDataProperty: "bytesBase64",
          rootData,
        })
      ) {
        vErrors =
          vErrors === null
            ? validate82.errors
            : vErrors.concat(validate82.errors);
        errors = vErrors.length;
      }
    }
    if (data.operationId !== void 0 && func0.call(data, "operationId")) {
      if (
        !validate26(data.operationId, {
          instancePath: instancePath + "/operationId",
          parentData: data,
          parentDataProperty: "operationId",
          rootData,
        })
      ) {
        vErrors =
          vErrors === null
            ? validate26.errors
            : vErrors.concat(validate26.errors);
        errors = vErrors.length;
      }
    }
  } else {
    const err5 = {
      instancePath,
      schemaPath: "#/type",
      keyword: "type",
      params: { type: "object" },
      message: "must be object",
    };
    if (vErrors === null) {
      vErrors = [err5];
    } else {
      vErrors.push(err5);
    }
    errors++;
  }
  validate90.errors = vErrors;
  return errors === 0;
}
var schema31 = {
  additionalProperties: false,
  properties: {
    acceptedRanges: {
      items: { $ref: "#/definitions/shared/definitions/ByteRange" },
      type: "array",
    },
    backendError: { $ref: "#/definitions/shared/definitions/HostError" },
    byteEnd: { $ref: "#/definitions/shared/definitions/U64" },
    byteStart: { $ref: "#/definitions/shared/definitions/U64" },
    bytesBase64: { $ref: "#/definitions/shared/definitions/Bytes" },
    operationId: { $ref: "#/definitions/shared/definitions/Id" },
    outcome: { $ref: "#/definitions/shared/definitions/TxOutcome" },
    peerAcknowledged: { $ref: "#/definitions/shared/definitions/False" },
    sessionEpoch: { $ref: "#/definitions/shared/definitions/U64" },
    sessionId: { $ref: "#/definitions/shared/definitions/Id" },
    unknownRanges: {
      items: { $ref: "#/definitions/shared/definitions/ByteRange" },
      type: "array",
    },
  },
  required: [
    "operationId",
    "sessionId",
    "sessionEpoch",
    "outcome",
    "bytesBase64",
    "byteStart",
    "byteEnd",
    "acceptedRanges",
    "unknownRanges",
    "peerAcknowledged",
  ],
  type: "object",
};
function validate97(
  data,
  { instancePath = "", parentData, parentDataProperty, rootData = data } = {},
) {
  let vErrors = null;
  let errors = 0;
  if (data && typeof data == "object" && !Array.isArray(data)) {
    if (data.start === void 0 || !func0.call(data, "start")) {
      const err0 = {
        instancePath,
        schemaPath: "#/required",
        keyword: "required",
        params: { missingProperty: "start" },
        message: "must have required property 'start'",
      };
      if (vErrors === null) {
        vErrors = [err0];
      } else {
        vErrors.push(err0);
      }
      errors++;
    }
    if (data.end === void 0 || !func0.call(data, "end")) {
      const err1 = {
        instancePath,
        schemaPath: "#/required",
        keyword: "required",
        params: { missingProperty: "end" },
        message: "must have required property 'end'",
      };
      if (vErrors === null) {
        vErrors = [err1];
      } else {
        vErrors.push(err1);
      }
      errors++;
    }
    for (const key0 of Object.keys(data)) {
      if (!(key0 === "end" || key0 === "start")) {
        const err2 = {
          instancePath,
          schemaPath: "#/additionalProperties",
          keyword: "additionalProperties",
          params: { additionalProperty: key0 },
          message: "must NOT have additional properties",
        };
        if (vErrors === null) {
          vErrors = [err2];
        } else {
          vErrors.push(err2);
        }
        errors++;
      }
    }
    if (data.end !== void 0 && func0.call(data, "end")) {
      if (
        !validate23(data.end, {
          instancePath: instancePath + "/end",
          parentData: data,
          parentDataProperty: "end",
          rootData,
        })
      ) {
        vErrors =
          vErrors === null
            ? validate23.errors
            : vErrors.concat(validate23.errors);
        errors = vErrors.length;
      }
    }
    if (data.start !== void 0 && func0.call(data, "start")) {
      if (
        !validate23(data.start, {
          instancePath: instancePath + "/start",
          parentData: data,
          parentDataProperty: "start",
          rootData,
        })
      ) {
        vErrors =
          vErrors === null
            ? validate23.errors
            : vErrors.concat(validate23.errors);
        errors = vErrors.length;
      }
    }
  } else {
    const err3 = {
      instancePath,
      schemaPath: "#/type",
      keyword: "type",
      params: { type: "object" },
      message: "must be object",
    };
    if (vErrors === null) {
      vErrors = [err3];
    } else {
      vErrors.push(err3);
    }
    errors++;
  }
  validate97.errors = vErrors;
  return errors === 0;
}
function validate101(
  data,
  { instancePath = "", parentData, parentDataProperty, rootData = data } = {},
) {
  let vErrors = null;
  let errors = 0;
  if (data && typeof data == "object" && !Array.isArray(data)) {
    if (data.code === void 0 || !func0.call(data, "code")) {
      const err0 = {
        instancePath,
        schemaPath: "#/required",
        keyword: "required",
        params: { missingProperty: "code" },
        message: "must have required property 'code'",
      };
      if (vErrors === null) {
        vErrors = [err0];
      } else {
        vErrors.push(err0);
      }
      errors++;
    }
    if (data.message === void 0 || !func0.call(data, "message")) {
      const err1 = {
        instancePath,
        schemaPath: "#/required",
        keyword: "required",
        params: { missingProperty: "message" },
        message: "must have required property 'message'",
      };
      if (vErrors === null) {
        vErrors = [err1];
      } else {
        vErrors.push(err1);
      }
      errors++;
    }
    if (data.retryable === void 0 || !func0.call(data, "retryable")) {
      const err2 = {
        instancePath,
        schemaPath: "#/required",
        keyword: "required",
        params: { missingProperty: "retryable" },
        message: "must have required property 'retryable'",
      };
      if (vErrors === null) {
        vErrors = [err2];
      } else {
        vErrors.push(err2);
      }
      errors++;
    }
    for (const key0 of Object.keys(data)) {
      if (!(
        key0 === "code" ||
        key0 === "details" ||
        key0 === "message" ||
        key0 === "operationId" ||
        key0 === "retryable" ||
        key0 === "revealTarget"
      )) {
        const err3 = {
          instancePath,
          schemaPath: "#/additionalProperties",
          keyword: "additionalProperties",
          params: { additionalProperty: key0 },
          message: "must NOT have additional properties",
        };
        if (vErrors === null) {
          vErrors = [err3];
        } else {
          vErrors.push(err3);
        }
        errors++;
      }
    }
    if (data.code !== void 0 && func0.call(data, "code")) {
      if (typeof data.code !== "string") {
        const err4 = {
          instancePath: instancePath + "/code",
          schemaPath: "#/properties/code/type",
          keyword: "type",
          params: { type: "string" },
          message: "must be string",
        };
        if (vErrors === null) {
          vErrors = [err4];
        } else {
          vErrors.push(err4);
        }
        errors++;
      }
    }
    if (data.details !== void 0 && func0.call(data, "details")) {
      let data1 = data.details;
      if (data1 && typeof data1 == "object" && !Array.isArray(data1)) {
        for (const key1 of Object.keys(data1)) {
          if (
            !validate52(data1[key1], {
              instancePath:
                instancePath +
                "/details/" +
                key1.replace(/~/g, "~0").replace(/\//g, "~1"),
              parentData: data1,
              parentDataProperty: key1,
              rootData,
            })
          ) {
            vErrors =
              vErrors === null
                ? validate52.errors
                : vErrors.concat(validate52.errors);
            errors = vErrors.length;
          }
        }
      } else {
        const err5 = {
          instancePath: instancePath + "/details",
          schemaPath: "#/properties/details/type",
          keyword: "type",
          params: { type: "object" },
          message: "must be object",
        };
        if (vErrors === null) {
          vErrors = [err5];
        } else {
          vErrors.push(err5);
        }
        errors++;
      }
    }
    if (data.message !== void 0 && func0.call(data, "message")) {
      if (typeof data.message !== "string") {
        const err6 = {
          instancePath: instancePath + "/message",
          schemaPath: "#/properties/message/type",
          keyword: "type",
          params: { type: "string" },
          message: "must be string",
        };
        if (vErrors === null) {
          vErrors = [err6];
        } else {
          vErrors.push(err6);
        }
        errors++;
      }
    }
    if (data.operationId !== void 0 && func0.call(data, "operationId")) {
      if (
        !validate26(data.operationId, {
          instancePath: instancePath + "/operationId",
          parentData: data,
          parentDataProperty: "operationId",
          rootData,
        })
      ) {
        vErrors =
          vErrors === null
            ? validate26.errors
            : vErrors.concat(validate26.errors);
        errors = vErrors.length;
      }
    }
    if (data.retryable !== void 0 && func0.call(data, "retryable")) {
      if (typeof data.retryable !== "boolean") {
        const err7 = {
          instancePath: instancePath + "/retryable",
          schemaPath: "#/properties/retryable/type",
          keyword: "type",
          params: { type: "boolean" },
          message: "must be boolean",
        };
        if (vErrors === null) {
          vErrors = [err7];
        } else {
          vErrors.push(err7);
        }
        errors++;
      }
    }
    if (data.revealTarget !== void 0 && func0.call(data, "revealTarget")) {
      if (
        !validate57(data.revealTarget, {
          instancePath: instancePath + "/revealTarget",
          parentData: data,
          parentDataProperty: "revealTarget",
          rootData,
        })
      ) {
        vErrors =
          vErrors === null
            ? validate57.errors
            : vErrors.concat(validate57.errors);
        errors = vErrors.length;
      }
    }
  } else {
    const err8 = {
      instancePath,
      schemaPath: "#/type",
      keyword: "type",
      params: { type: "object" },
      message: "must be object",
    };
    if (vErrors === null) {
      vErrors = [err8];
    } else {
      vErrors.push(err8);
    }
    errors++;
  }
  validate101.errors = vErrors;
  return errors === 0;
}
var schema34 = {
  enum: ["accepted", "partial", "rejected", "unknown"],
  type: "string",
};
function validate110(
  data,
  { instancePath = "", parentData, parentDataProperty, rootData = data } = {},
) {
  let vErrors = null;
  let errors = 0;
  if (typeof data !== "string") {
    const err0 = {
      instancePath,
      schemaPath: "#/type",
      keyword: "type",
      params: { type: "string" },
      message: "must be string",
    };
    if (vErrors === null) {
      vErrors = [err0];
    } else {
      vErrors.push(err0);
    }
    errors++;
  }
  if (!(
    data === "accepted" ||
    data === "partial" ||
    data === "rejected" ||
    data === "unknown"
  )) {
    const err1 = {
      instancePath,
      schemaPath: "#/enum",
      keyword: "enum",
      params: { allowedValues: schema34.enum },
      message: "must be equal to one of the allowed values",
    };
    if (vErrors === null) {
      vErrors = [err1];
    } else {
      vErrors.push(err1);
    }
    errors++;
  }
  validate110.errors = vErrors;
  return errors === 0;
}
function validate112(
  data,
  { instancePath = "", parentData, parentDataProperty, rootData = data } = {},
) {
  let vErrors = null;
  let errors = 0;
  if (typeof data !== "boolean") {
    const err0 = {
      instancePath,
      schemaPath: "#/type",
      keyword: "type",
      params: { type: "boolean" },
      message: "must be boolean",
    };
    if (vErrors === null) {
      vErrors = [err0];
    } else {
      vErrors.push(err0);
    }
    errors++;
  }
  if (false !== data) {
    const err1 = {
      instancePath,
      schemaPath: "#/const",
      keyword: "const",
      params: { allowedValue: false },
      message: "must be equal to constant",
    };
    if (vErrors === null) {
      vErrors = [err1];
    } else {
      vErrors.push(err1);
    }
    errors++;
  }
  validate112.errors = vErrors;
  return errors === 0;
}
function validate96(
  data,
  { instancePath = "", parentData, parentDataProperty, rootData = data } = {},
) {
  let vErrors = null;
  let errors = 0;
  if (data && typeof data == "object" && !Array.isArray(data)) {
    if (data.operationId === void 0 || !func0.call(data, "operationId")) {
      const err0 = {
        instancePath,
        schemaPath: "#/required",
        keyword: "required",
        params: { missingProperty: "operationId" },
        message: "must have required property 'operationId'",
      };
      if (vErrors === null) {
        vErrors = [err0];
      } else {
        vErrors.push(err0);
      }
      errors++;
    }
    if (data.sessionId === void 0 || !func0.call(data, "sessionId")) {
      const err1 = {
        instancePath,
        schemaPath: "#/required",
        keyword: "required",
        params: { missingProperty: "sessionId" },
        message: "must have required property 'sessionId'",
      };
      if (vErrors === null) {
        vErrors = [err1];
      } else {
        vErrors.push(err1);
      }
      errors++;
    }
    if (data.sessionEpoch === void 0 || !func0.call(data, "sessionEpoch")) {
      const err2 = {
        instancePath,
        schemaPath: "#/required",
        keyword: "required",
        params: { missingProperty: "sessionEpoch" },
        message: "must have required property 'sessionEpoch'",
      };
      if (vErrors === null) {
        vErrors = [err2];
      } else {
        vErrors.push(err2);
      }
      errors++;
    }
    if (data.outcome === void 0 || !func0.call(data, "outcome")) {
      const err3 = {
        instancePath,
        schemaPath: "#/required",
        keyword: "required",
        params: { missingProperty: "outcome" },
        message: "must have required property 'outcome'",
      };
      if (vErrors === null) {
        vErrors = [err3];
      } else {
        vErrors.push(err3);
      }
      errors++;
    }
    if (data.bytesBase64 === void 0 || !func0.call(data, "bytesBase64")) {
      const err4 = {
        instancePath,
        schemaPath: "#/required",
        keyword: "required",
        params: { missingProperty: "bytesBase64" },
        message: "must have required property 'bytesBase64'",
      };
      if (vErrors === null) {
        vErrors = [err4];
      } else {
        vErrors.push(err4);
      }
      errors++;
    }
    if (data.byteStart === void 0 || !func0.call(data, "byteStart")) {
      const err5 = {
        instancePath,
        schemaPath: "#/required",
        keyword: "required",
        params: { missingProperty: "byteStart" },
        message: "must have required property 'byteStart'",
      };
      if (vErrors === null) {
        vErrors = [err5];
      } else {
        vErrors.push(err5);
      }
      errors++;
    }
    if (data.byteEnd === void 0 || !func0.call(data, "byteEnd")) {
      const err6 = {
        instancePath,
        schemaPath: "#/required",
        keyword: "required",
        params: { missingProperty: "byteEnd" },
        message: "must have required property 'byteEnd'",
      };
      if (vErrors === null) {
        vErrors = [err6];
      } else {
        vErrors.push(err6);
      }
      errors++;
    }
    if (data.acceptedRanges === void 0 || !func0.call(data, "acceptedRanges")) {
      const err7 = {
        instancePath,
        schemaPath: "#/required",
        keyword: "required",
        params: { missingProperty: "acceptedRanges" },
        message: "must have required property 'acceptedRanges'",
      };
      if (vErrors === null) {
        vErrors = [err7];
      } else {
        vErrors.push(err7);
      }
      errors++;
    }
    if (data.unknownRanges === void 0 || !func0.call(data, "unknownRanges")) {
      const err8 = {
        instancePath,
        schemaPath: "#/required",
        keyword: "required",
        params: { missingProperty: "unknownRanges" },
        message: "must have required property 'unknownRanges'",
      };
      if (vErrors === null) {
        vErrors = [err8];
      } else {
        vErrors.push(err8);
      }
      errors++;
    }
    if (
      data.peerAcknowledged === void 0 ||
      !func0.call(data, "peerAcknowledged")
    ) {
      const err9 = {
        instancePath,
        schemaPath: "#/required",
        keyword: "required",
        params: { missingProperty: "peerAcknowledged" },
        message: "must have required property 'peerAcknowledged'",
      };
      if (vErrors === null) {
        vErrors = [err9];
      } else {
        vErrors.push(err9);
      }
      errors++;
    }
    for (const key0 of Object.keys(data)) {
      if (!func0.call(schema31.properties, key0)) {
        const err10 = {
          instancePath,
          schemaPath: "#/additionalProperties",
          keyword: "additionalProperties",
          params: { additionalProperty: key0 },
          message: "must NOT have additional properties",
        };
        if (vErrors === null) {
          vErrors = [err10];
        } else {
          vErrors.push(err10);
        }
        errors++;
      }
    }
    if (data.acceptedRanges !== void 0 && func0.call(data, "acceptedRanges")) {
      let data0 = data.acceptedRanges;
      if (Array.isArray(data0)) {
        const len0 = data0.length;
        for (let i0 = 0; i0 < len0; i0++) {
          if (
            !validate97(data0[i0], {
              instancePath: instancePath + "/acceptedRanges/" + i0,
              parentData: data0,
              parentDataProperty: i0,
              rootData,
            })
          ) {
            vErrors =
              vErrors === null
                ? validate97.errors
                : vErrors.concat(validate97.errors);
            errors = vErrors.length;
          }
        }
      } else {
        const err11 = {
          instancePath: instancePath + "/acceptedRanges",
          schemaPath: "#/properties/acceptedRanges/type",
          keyword: "type",
          params: { type: "array" },
          message: "must be array",
        };
        if (vErrors === null) {
          vErrors = [err11];
        } else {
          vErrors.push(err11);
        }
        errors++;
      }
    }
    if (data.backendError !== void 0 && func0.call(data, "backendError")) {
      if (
        !validate101(data.backendError, {
          instancePath: instancePath + "/backendError",
          parentData: data,
          parentDataProperty: "backendError",
          rootData,
        })
      ) {
        vErrors =
          vErrors === null
            ? validate101.errors
            : vErrors.concat(validate101.errors);
        errors = vErrors.length;
      }
    }
    if (data.byteEnd !== void 0 && func0.call(data, "byteEnd")) {
      if (
        !validate23(data.byteEnd, {
          instancePath: instancePath + "/byteEnd",
          parentData: data,
          parentDataProperty: "byteEnd",
          rootData,
        })
      ) {
        vErrors =
          vErrors === null
            ? validate23.errors
            : vErrors.concat(validate23.errors);
        errors = vErrors.length;
      }
    }
    if (data.byteStart !== void 0 && func0.call(data, "byteStart")) {
      if (
        !validate23(data.byteStart, {
          instancePath: instancePath + "/byteStart",
          parentData: data,
          parentDataProperty: "byteStart",
          rootData,
        })
      ) {
        vErrors =
          vErrors === null
            ? validate23.errors
            : vErrors.concat(validate23.errors);
        errors = vErrors.length;
      }
    }
    if (data.bytesBase64 !== void 0 && func0.call(data, "bytesBase64")) {
      if (
        !validate82(data.bytesBase64, {
          instancePath: instancePath + "/bytesBase64",
          parentData: data,
          parentDataProperty: "bytesBase64",
          rootData,
        })
      ) {
        vErrors =
          vErrors === null
            ? validate82.errors
            : vErrors.concat(validate82.errors);
        errors = vErrors.length;
      }
    }
    if (data.operationId !== void 0 && func0.call(data, "operationId")) {
      if (
        !validate26(data.operationId, {
          instancePath: instancePath + "/operationId",
          parentData: data,
          parentDataProperty: "operationId",
          rootData,
        })
      ) {
        vErrors =
          vErrors === null
            ? validate26.errors
            : vErrors.concat(validate26.errors);
        errors = vErrors.length;
      }
    }
    if (data.outcome !== void 0 && func0.call(data, "outcome")) {
      if (
        !validate110(data.outcome, {
          instancePath: instancePath + "/outcome",
          parentData: data,
          parentDataProperty: "outcome",
          rootData,
        })
      ) {
        vErrors =
          vErrors === null
            ? validate110.errors
            : vErrors.concat(validate110.errors);
        errors = vErrors.length;
      }
    }
    if (
      data.peerAcknowledged !== void 0 &&
      func0.call(data, "peerAcknowledged")
    ) {
      if (
        !validate112(data.peerAcknowledged, {
          instancePath: instancePath + "/peerAcknowledged",
          parentData: data,
          parentDataProperty: "peerAcknowledged",
          rootData,
        })
      ) {
        vErrors =
          vErrors === null
            ? validate112.errors
            : vErrors.concat(validate112.errors);
        errors = vErrors.length;
      }
    }
    if (data.sessionEpoch !== void 0 && func0.call(data, "sessionEpoch")) {
      if (
        !validate23(data.sessionEpoch, {
          instancePath: instancePath + "/sessionEpoch",
          parentData: data,
          parentDataProperty: "sessionEpoch",
          rootData,
        })
      ) {
        vErrors =
          vErrors === null
            ? validate23.errors
            : vErrors.concat(validate23.errors);
        errors = vErrors.length;
      }
    }
    if (data.sessionId !== void 0 && func0.call(data, "sessionId")) {
      if (
        !validate26(data.sessionId, {
          instancePath: instancePath + "/sessionId",
          parentData: data,
          parentDataProperty: "sessionId",
          rootData,
        })
      ) {
        vErrors =
          vErrors === null
            ? validate26.errors
            : vErrors.concat(validate26.errors);
        errors = vErrors.length;
      }
    }
    if (data.unknownRanges !== void 0 && func0.call(data, "unknownRanges")) {
      let data11 = data.unknownRanges;
      if (Array.isArray(data11)) {
        const len1 = data11.length;
        for (let i1 = 0; i1 < len1; i1++) {
          if (
            !validate97(data11[i1], {
              instancePath: instancePath + "/unknownRanges/" + i1,
              parentData: data11,
              parentDataProperty: i1,
              rootData,
            })
          ) {
            vErrors =
              vErrors === null
                ? validate97.errors
                : vErrors.concat(validate97.errors);
            errors = vErrors.length;
          }
        }
      } else {
        const err12 = {
          instancePath: instancePath + "/unknownRanges",
          schemaPath: "#/properties/unknownRanges/type",
          keyword: "type",
          params: { type: "array" },
          message: "must be array",
        };
        if (vErrors === null) {
          vErrors = [err12];
        } else {
          vErrors.push(err12);
        }
        errors++;
      }
    }
  } else {
    const err13 = {
      instancePath,
      schemaPath: "#/type",
      keyword: "type",
      params: { type: "object" },
      message: "must be object",
    };
    if (vErrors === null) {
      vErrors = [err13];
    } else {
      vErrors.push(err13);
    }
    errors++;
  }
  validate96.errors = vErrors;
  return errors === 0;
}
function validate120(
  data,
  { instancePath = "", parentData, parentDataProperty, rootData = data } = {},
) {
  let vErrors = null;
  let errors = 0;
  if (data && typeof data == "object" && !Array.isArray(data)) {
    if (data.direction === void 0 || !func0.call(data, "direction")) {
      const err0 = {
        instancePath,
        schemaPath: "#/required",
        keyword: "required",
        params: { missingProperty: "direction" },
        message: "must have required property 'direction'",
      };
      if (vErrors === null) {
        vErrors = [err0];
      } else {
        vErrors.push(err0);
      }
      errors++;
    }
    if (data.start === void 0 || !func0.call(data, "start")) {
      const err1 = {
        instancePath,
        schemaPath: "#/required",
        keyword: "required",
        params: { missingProperty: "start" },
        message: "must have required property 'start'",
      };
      if (vErrors === null) {
        vErrors = [err1];
      } else {
        vErrors.push(err1);
      }
      errors++;
    }
    if (data.end === void 0 || !func0.call(data, "end")) {
      const err2 = {
        instancePath,
        schemaPath: "#/required",
        keyword: "required",
        params: { missingProperty: "end" },
        message: "must have required property 'end'",
      };
      if (vErrors === null) {
        vErrors = [err2];
      } else {
        vErrors.push(err2);
      }
      errors++;
    }
    for (const key0 of Object.keys(data)) {
      if (!(key0 === "direction" || key0 === "end" || key0 === "start")) {
        const err3 = {
          instancePath,
          schemaPath: "#/additionalProperties",
          keyword: "additionalProperties",
          params: { additionalProperty: key0 },
          message: "must NOT have additional properties",
        };
        if (vErrors === null) {
          vErrors = [err3];
        } else {
          vErrors.push(err3);
        }
        errors++;
      }
    }
    if (data.direction !== void 0 && func0.call(data, "direction")) {
      if (
        !validate39(data.direction, {
          instancePath: instancePath + "/direction",
          parentData: data,
          parentDataProperty: "direction",
          rootData,
        })
      ) {
        vErrors =
          vErrors === null
            ? validate39.errors
            : vErrors.concat(validate39.errors);
        errors = vErrors.length;
      }
    }
    if (data.end !== void 0 && func0.call(data, "end")) {
      if (
        !validate23(data.end, {
          instancePath: instancePath + "/end",
          parentData: data,
          parentDataProperty: "end",
          rootData,
        })
      ) {
        vErrors =
          vErrors === null
            ? validate23.errors
            : vErrors.concat(validate23.errors);
        errors = vErrors.length;
      }
    }
    if (data.start !== void 0 && func0.call(data, "start")) {
      if (
        !validate23(data.start, {
          instancePath: instancePath + "/start",
          parentData: data,
          parentDataProperty: "start",
          rootData,
        })
      ) {
        vErrors =
          vErrors === null
            ? validate23.errors
            : vErrors.concat(validate23.errors);
        errors = vErrors.length;
      }
    }
  } else {
    const err4 = {
      instancePath,
      schemaPath: "#/type",
      keyword: "type",
      params: { type: "object" },
      message: "must be object",
    };
    if (vErrors === null) {
      vErrors = [err4];
    } else {
      vErrors.push(err4);
    }
    errors++;
  }
  validate120.errors = vErrors;
  return errors === 0;
}
var schema38 = {
  enum: ["network_loss", "backend_loss", "purge", "source_unknown"],
  type: "string",
};
function validate126(
  data,
  { instancePath = "", parentData, parentDataProperty, rootData = data } = {},
) {
  let vErrors = null;
  let errors = 0;
  if (typeof data !== "string") {
    const err0 = {
      instancePath,
      schemaPath: "#/type",
      keyword: "type",
      params: { type: "string" },
      message: "must be string",
    };
    if (vErrors === null) {
      vErrors = [err0];
    } else {
      vErrors.push(err0);
    }
    errors++;
  }
  if (!(
    data === "network_loss" ||
    data === "backend_loss" ||
    data === "purge" ||
    data === "source_unknown"
  )) {
    const err1 = {
      instancePath,
      schemaPath: "#/enum",
      keyword: "enum",
      params: { allowedValues: schema38.enum },
      message: "must be equal to one of the allowed values",
    };
    if (vErrors === null) {
      vErrors = [err1];
    } else {
      vErrors.push(err1);
    }
    errors++;
  }
  validate126.errors = vErrors;
  return errors === 0;
}
function validate118(
  data,
  { instancePath = "", parentData, parentDataProperty, rootData = data } = {},
) {
  let vErrors = null;
  let errors = 0;
  if (data && typeof data == "object" && !Array.isArray(data)) {
    if (data.reason === void 0 || !func0.call(data, "reason")) {
      const err0 = {
        instancePath,
        schemaPath: "#/required",
        keyword: "required",
        params: { missingProperty: "reason" },
        message: "must have required property 'reason'",
      };
      if (vErrors === null) {
        vErrors = [err0];
      } else {
        vErrors.push(err0);
      }
      errors++;
    }
    if (data.knownExtent === void 0 || !func0.call(data, "knownExtent")) {
      const err1 = {
        instancePath,
        schemaPath: "#/required",
        keyword: "required",
        params: { missingProperty: "knownExtent" },
        message: "must have required property 'knownExtent'",
      };
      if (vErrors === null) {
        vErrors = [err1];
      } else {
        vErrors.push(err1);
      }
      errors++;
    }
    for (const key0 of Object.keys(data)) {
      if (!(
        key0 === "direction" ||
        key0 === "knownExtent" ||
        key0 === "missingByteRange" ||
        key0 === "missingEventRange" ||
        key0 === "reason"
      )) {
        const err2 = {
          instancePath,
          schemaPath: "#/additionalProperties",
          keyword: "additionalProperties",
          params: { additionalProperty: key0 },
          message: "must NOT have additional properties",
        };
        if (vErrors === null) {
          vErrors = [err2];
        } else {
          vErrors.push(err2);
        }
        errors++;
      }
    }
    if (data.direction !== void 0 && func0.call(data, "direction")) {
      if (
        !validate39(data.direction, {
          instancePath: instancePath + "/direction",
          parentData: data,
          parentDataProperty: "direction",
          rootData,
        })
      ) {
        vErrors =
          vErrors === null
            ? validate39.errors
            : vErrors.concat(validate39.errors);
        errors = vErrors.length;
      }
    }
    if (data.knownExtent !== void 0 && func0.call(data, "knownExtent")) {
      if (typeof data.knownExtent !== "boolean") {
        const err3 = {
          instancePath: instancePath + "/knownExtent",
          schemaPath: "#/properties/knownExtent/type",
          keyword: "type",
          params: { type: "boolean" },
          message: "must be boolean",
        };
        if (vErrors === null) {
          vErrors = [err3];
        } else {
          vErrors.push(err3);
        }
        errors++;
      }
    }
    if (
      data.missingByteRange !== void 0 &&
      func0.call(data, "missingByteRange")
    ) {
      if (
        !validate120(data.missingByteRange, {
          instancePath: instancePath + "/missingByteRange",
          parentData: data,
          parentDataProperty: "missingByteRange",
          rootData,
        })
      ) {
        vErrors =
          vErrors === null
            ? validate120.errors
            : vErrors.concat(validate120.errors);
        errors = vErrors.length;
      }
    }
    if (
      data.missingEventRange !== void 0 &&
      func0.call(data, "missingEventRange")
    ) {
      if (
        !validate97(data.missingEventRange, {
          instancePath: instancePath + "/missingEventRange",
          parentData: data,
          parentDataProperty: "missingEventRange",
          rootData,
        })
      ) {
        vErrors =
          vErrors === null
            ? validate97.errors
            : vErrors.concat(validate97.errors);
        errors = vErrors.length;
      }
    }
    if (data.reason !== void 0 && func0.call(data, "reason")) {
      if (
        !validate126(data.reason, {
          instancePath: instancePath + "/reason",
          parentData: data,
          parentDataProperty: "reason",
          rootData,
        })
      ) {
        vErrors =
          vErrors === null
            ? validate126.errors
            : vErrors.concat(validate126.errors);
        errors = vErrors.length;
      }
    }
  } else {
    const err4 = {
      instancePath,
      schemaPath: "#/type",
      keyword: "type",
      params: { type: "object" },
      message: "must be object",
    };
    if (vErrors === null) {
      vErrors = [err4];
    } else {
      vErrors.push(err4);
    }
    errors++;
  }
  validate118.errors = vErrors;
  return errors === 0;
}
var schema40 = { enum: ["confirmed", "uncertain"], type: "string" };
function validate130(
  data,
  { instancePath = "", parentData, parentDataProperty, rootData = data } = {},
) {
  let vErrors = null;
  let errors = 0;
  if (typeof data !== "string") {
    const err0 = {
      instancePath,
      schemaPath: "#/type",
      keyword: "type",
      params: { type: "string" },
      message: "must be string",
    };
    if (vErrors === null) {
      vErrors = [err0];
    } else {
      vErrors.push(err0);
    }
    errors++;
  }
  if (!(data === "confirmed" || data === "uncertain")) {
    const err1 = {
      instancePath,
      schemaPath: "#/enum",
      keyword: "enum",
      params: { allowedValues: schema40.enum },
      message: "must be equal to one of the allowed values",
    };
    if (vErrors === null) {
      vErrors = [err1];
    } else {
      vErrors.push(err1);
    }
    errors++;
  }
  validate130.errors = vErrors;
  return errors === 0;
}
function validate129(
  data,
  { instancePath = "", parentData, parentDataProperty, rootData = data } = {},
) {
  let vErrors = null;
  let errors = 0;
  if (data && typeof data == "object" && !Array.isArray(data)) {
    if (data.revision === void 0 || !func0.call(data, "revision")) {
      const err0 = {
        instancePath,
        schemaPath: "#/required",
        keyword: "required",
        params: { missingProperty: "revision" },
        message: "must have required property 'revision'",
      };
      if (vErrors === null) {
        vErrors = [err0];
      } else {
        vErrors.push(err0);
      }
      errors++;
    }
    if (data.certainty === void 0 || !func0.call(data, "certainty")) {
      const err1 = {
        instancePath,
        schemaPath: "#/required",
        keyword: "required",
        params: { missingProperty: "certainty" },
        message: "must have required property 'certainty'",
      };
      if (vErrors === null) {
        vErrors = [err1];
      } else {
        vErrors.push(err1);
      }
      errors++;
    }
    if (data.receiptRef === void 0 || !func0.call(data, "receiptRef")) {
      const err2 = {
        instancePath,
        schemaPath: "#/required",
        keyword: "required",
        params: { missingProperty: "receiptRef" },
        message: "must have required property 'receiptRef'",
      };
      if (vErrors === null) {
        vErrors = [err2];
      } else {
        vErrors.push(err2);
      }
      errors++;
    }
    for (const key0 of Object.keys(data)) {
      if (!(
        key0 === "certainty" ||
        key0 === "receiptRef" ||
        key0 === "revision"
      )) {
        const err3 = {
          instancePath,
          schemaPath: "#/additionalProperties",
          keyword: "additionalProperties",
          params: { additionalProperty: key0 },
          message: "must NOT have additional properties",
        };
        if (vErrors === null) {
          vErrors = [err3];
        } else {
          vErrors.push(err3);
        }
        errors++;
      }
    }
    if (data.certainty !== void 0 && func0.call(data, "certainty")) {
      if (
        !validate130(data.certainty, {
          instancePath: instancePath + "/certainty",
          parentData: data,
          parentDataProperty: "certainty",
          rootData,
        })
      ) {
        vErrors =
          vErrors === null
            ? validate130.errors
            : vErrors.concat(validate130.errors);
        errors = vErrors.length;
      }
    }
    if (data.receiptRef !== void 0 && func0.call(data, "receiptRef")) {
      if (
        !validate60(data.receiptRef, {
          instancePath: instancePath + "/receiptRef",
          parentData: data,
          parentDataProperty: "receiptRef",
          rootData,
        })
      ) {
        vErrors =
          vErrors === null
            ? validate60.errors
            : vErrors.concat(validate60.errors);
        errors = vErrors.length;
      }
    }
    if (data.revision !== void 0 && func0.call(data, "revision")) {
      if (
        !validate23(data.revision, {
          instancePath: instancePath + "/revision",
          parentData: data,
          parentDataProperty: "revision",
          rootData,
        })
      ) {
        vErrors =
          vErrors === null
            ? validate23.errors
            : vErrors.concat(validate23.errors);
        errors = vErrors.length;
      }
    }
  } else {
    const err4 = {
      instancePath,
      schemaPath: "#/type",
      keyword: "type",
      params: { type: "object" },
      message: "must be object",
    };
    if (vErrors === null) {
      vErrors = [err4];
    } else {
      vErrors.push(err4);
    }
    errors++;
  }
  validate129.errors = vErrors;
  return errors === 0;
}
var pattern5 = new RegExp("^(?:0|-?[1-9][0-9]*)$", "u");
function validate147(
  data,
  { instancePath = "", parentData, parentDataProperty, rootData = data } = {},
) {
  let vErrors = null;
  let errors = 0;
  if (typeof data === "string") {
    if (!pattern5.test(data)) {
      const err0 = {
        instancePath,
        schemaPath: "#/pattern",
        keyword: "pattern",
        params: { pattern: "^(?:0|-?[1-9][0-9]*)$" },
        message: 'must match pattern "^(?:0|-?[1-9][0-9]*)$"',
      };
      if (vErrors === null) {
        vErrors = [err0];
      } else {
        vErrors.push(err0);
      }
      errors++;
    }
  } else {
    const err1 = {
      instancePath,
      schemaPath: "#/type",
      keyword: "type",
      params: { type: "string" },
      message: "must be string",
    };
    if (vErrors === null) {
      vErrors = [err1];
    } else {
      vErrors.push(err1);
    }
    errors++;
  }
  validate147.errors = vErrors;
  return errors === 0;
}
var schema44 = {
  enum: ["host_read", "device", "line_capture", "sample_clock"],
  type: "string",
};
function validate151(
  data,
  { instancePath = "", parentData, parentDataProperty, rootData = data } = {},
) {
  let vErrors = null;
  let errors = 0;
  if (typeof data !== "string") {
    const err0 = {
      instancePath,
      schemaPath: "#/type",
      keyword: "type",
      params: { type: "string" },
      message: "must be string",
    };
    if (vErrors === null) {
      vErrors = [err0];
    } else {
      vErrors.push(err0);
    }
    errors++;
  }
  if (!(
    data === "host_read" ||
    data === "device" ||
    data === "line_capture" ||
    data === "sample_clock"
  )) {
    const err1 = {
      instancePath,
      schemaPath: "#/enum",
      keyword: "enum",
      params: { allowedValues: schema44.enum },
      message: "must be equal to one of the allowed values",
    };
    if (vErrors === null) {
      vErrors = [err1];
    } else {
      vErrors.push(err1);
    }
    errors++;
  }
  validate151.errors = vErrors;
  return errors === 0;
}
function validate145(
  data,
  { instancePath = "", parentData, parentDataProperty, rootData = data } = {},
) {
  let vErrors = null;
  let errors = 0;
  if (data && typeof data == "object" && !Array.isArray(data)) {
    if (data.source === void 0 || !func0.call(data, "source")) {
      const err0 = {
        instancePath,
        schemaPath: "#/required",
        keyword: "required",
        params: { missingProperty: "source" },
        message: "must have required property 'source'",
      };
      if (vErrors === null) {
        vErrors = [err0];
      } else {
        vErrors.push(err0);
      }
      errors++;
    }
    if (data.resolutionNs === void 0 || !func0.call(data, "resolutionNs")) {
      const err1 = {
        instancePath,
        schemaPath: "#/required",
        keyword: "required",
        params: { missingProperty: "resolutionNs" },
        message: "must have required property 'resolutionNs'",
      };
      if (vErrors === null) {
        vErrors = [err1];
      } else {
        vErrors.push(err1);
      }
      errors++;
    }
    if (data.syncMethod === void 0 || !func0.call(data, "syncMethod")) {
      const err2 = {
        instancePath,
        schemaPath: "#/required",
        keyword: "required",
        params: { missingProperty: "syncMethod" },
        message: "must have required property 'syncMethod'",
      };
      if (vErrors === null) {
        vErrors = [err2];
      } else {
        vErrors.push(err2);
      }
      errors++;
    }
    for (const key0 of Object.keys(data)) {
      if (!(
        key0 === "offsetErrorNs" ||
        key0 === "offsetEstimateNs" ||
        key0 === "resolutionNs" ||
        key0 === "rttNs" ||
        key0 === "source" ||
        key0 === "syncMethod"
      )) {
        const err3 = {
          instancePath,
          schemaPath: "#/additionalProperties",
          keyword: "additionalProperties",
          params: { additionalProperty: key0 },
          message: "must NOT have additional properties",
        };
        if (vErrors === null) {
          vErrors = [err3];
        } else {
          vErrors.push(err3);
        }
        errors++;
      }
    }
    if (data.offsetErrorNs !== void 0 && func0.call(data, "offsetErrorNs")) {
      if (
        !validate23(data.offsetErrorNs, {
          instancePath: instancePath + "/offsetErrorNs",
          parentData: data,
          parentDataProperty: "offsetErrorNs",
          rootData,
        })
      ) {
        vErrors =
          vErrors === null
            ? validate23.errors
            : vErrors.concat(validate23.errors);
        errors = vErrors.length;
      }
    }
    if (
      data.offsetEstimateNs !== void 0 &&
      func0.call(data, "offsetEstimateNs")
    ) {
      if (
        !validate147(data.offsetEstimateNs, {
          instancePath: instancePath + "/offsetEstimateNs",
          parentData: data,
          parentDataProperty: "offsetEstimateNs",
          rootData,
        })
      ) {
        vErrors =
          vErrors === null
            ? validate147.errors
            : vErrors.concat(validate147.errors);
        errors = vErrors.length;
      }
    }
    if (data.resolutionNs !== void 0 && func0.call(data, "resolutionNs")) {
      if (
        !validate23(data.resolutionNs, {
          instancePath: instancePath + "/resolutionNs",
          parentData: data,
          parentDataProperty: "resolutionNs",
          rootData,
        })
      ) {
        vErrors =
          vErrors === null
            ? validate23.errors
            : vErrors.concat(validate23.errors);
        errors = vErrors.length;
      }
    }
    if (data.rttNs !== void 0 && func0.call(data, "rttNs")) {
      if (
        !validate23(data.rttNs, {
          instancePath: instancePath + "/rttNs",
          parentData: data,
          parentDataProperty: "rttNs",
          rootData,
        })
      ) {
        vErrors =
          vErrors === null
            ? validate23.errors
            : vErrors.concat(validate23.errors);
        errors = vErrors.length;
      }
    }
    if (data.source !== void 0 && func0.call(data, "source")) {
      if (
        !validate151(data.source, {
          instancePath: instancePath + "/source",
          parentData: data,
          parentDataProperty: "source",
          rootData,
        })
      ) {
        vErrors =
          vErrors === null
            ? validate151.errors
            : vErrors.concat(validate151.errors);
        errors = vErrors.length;
      }
    }
    if (data.syncMethod !== void 0 && func0.call(data, "syncMethod")) {
      if (typeof data.syncMethod !== "string") {
        const err4 = {
          instancePath: instancePath + "/syncMethod",
          schemaPath: "#/properties/syncMethod/type",
          keyword: "type",
          params: { type: "string" },
          message: "must be string",
        };
        if (vErrors === null) {
          vErrors = [err4];
        } else {
          vErrors.push(err4);
        }
        errors++;
      }
    }
  } else {
    const err5 = {
      instancePath,
      schemaPath: "#/type",
      keyword: "type",
      params: { type: "object" },
      message: "must be object",
    };
    if (vErrors === null) {
      vErrors = [err5];
    } else {
      vErrors.push(err5);
    }
    errors++;
  }
  validate145.errors = vErrors;
  return errors === 0;
}
var pattern6 = new RegExp(
  "^(?:(?:[0-9]{4}-(?:(?:01|03|05|07|08|10|12)-(?:0[1-9]|[12][0-9]|3[01])|(?:04|06|09|11)-(?:0[1-9]|[12][0-9]|30)|02-(?:0[1-9]|1[0-9]|2[0-8]))|(?:[0-9]{2}(?:0[48]|[2468][048]|[13579][26])|(?:[02468][048]|[13579][26])00)-02-29)[Tt](?:[01][0-9]|2[0-3]):[0-5][0-9]:[0-5][0-9]|(?:[0-9]{4}-(?:(?:01|03|05|07|08|10|12)-31|(?:04|06|09|11)-30)|(?:[0-9]{2}(?:0[48]|[2468][048]|[13579][26])|(?:[02468][048]|[13579][26])00)-02-29|(?!(?:(?:[0-9]{2}(?:0[48]|[2468][048]|[13579][26])|(?:[02468][048]|[13579][26])00))-)[0-9]{4}-02-28)[Tt]23:59:60)(?:\\.[0-9]+)?(?:[Zz]|\\+00:00)$",
  "u",
);
function validate154(
  data,
  { instancePath = "", parentData, parentDataProperty, rootData = data } = {},
) {
  let vErrors = null;
  let errors = 0;
  if (typeof data === "string") {
    if (!pattern6.test(data)) {
      const err0 = {
        instancePath,
        schemaPath: "#/pattern",
        keyword: "pattern",
        params: {
          pattern:
            "^(?:(?:[0-9]{4}-(?:(?:01|03|05|07|08|10|12)-(?:0[1-9]|[12][0-9]|3[01])|(?:04|06|09|11)-(?:0[1-9]|[12][0-9]|30)|02-(?:0[1-9]|1[0-9]|2[0-8]))|(?:[0-9]{2}(?:0[48]|[2468][048]|[13579][26])|(?:[02468][048]|[13579][26])00)-02-29)[Tt](?:[01][0-9]|2[0-3]):[0-5][0-9]:[0-5][0-9]|(?:[0-9]{4}-(?:(?:01|03|05|07|08|10|12)-31|(?:04|06|09|11)-30)|(?:[0-9]{2}(?:0[48]|[2468][048]|[13579][26])|(?:[02468][048]|[13579][26])00)-02-29|(?!(?:(?:[0-9]{2}(?:0[48]|[2468][048]|[13579][26])|(?:[02468][048]|[13579][26])00))-)[0-9]{4}-02-28)[Tt]23:59:60)(?:\\.[0-9]+)?(?:[Zz]|\\+00:00)$",
        },
        message:
          'must match pattern "^(?:(?:[0-9]{4}-(?:(?:01|03|05|07|08|10|12)-(?:0[1-9]|[12][0-9]|3[01])|(?:04|06|09|11)-(?:0[1-9]|[12][0-9]|30)|02-(?:0[1-9]|1[0-9]|2[0-8]))|(?:[0-9]{2}(?:0[48]|[2468][048]|[13579][26])|(?:[02468][048]|[13579][26])00)-02-29)[Tt](?:[01][0-9]|2[0-3]):[0-5][0-9]:[0-5][0-9]|(?:[0-9]{4}-(?:(?:01|03|05|07|08|10|12)-31|(?:04|06|09|11)-30)|(?:[0-9]{2}(?:0[48]|[2468][048]|[13579][26])|(?:[02468][048]|[13579][26])00)-02-29|(?!(?:(?:[0-9]{2}(?:0[48]|[2468][048]|[13579][26])|(?:[02468][048]|[13579][26])00))-)[0-9]{4}-02-28)[Tt]23:59:60)(?:\\.[0-9]+)?(?:[Zz]|\\+00:00)$"',
      };
      if (vErrors === null) {
        vErrors = [err0];
      } else {
        vErrors.push(err0);
      }
      errors++;
    }
  } else {
    const err1 = {
      instancePath,
      schemaPath: "#/type",
      keyword: "type",
      params: { type: "string" },
      message: "must be string",
    };
    if (vErrors === null) {
      vErrors = [err1];
    } else {
      vErrors.push(err1);
    }
    errors++;
  }
  validate154.errors = vErrors;
  return errors === 0;
}
function validate143(
  data,
  { instancePath = "", parentData, parentDataProperty, rootData = data } = {},
) {
  let vErrors = null;
  let errors = 0;
  if (data && typeof data == "object" && !Array.isArray(data)) {
    if (data.clockId === void 0 || !func0.call(data, "clockId")) {
      const err0 = {
        instancePath,
        schemaPath: "#/required",
        keyword: "required",
        params: { missingProperty: "clockId" },
        message: "must have required property 'clockId'",
      };
      if (vErrors === null) {
        vErrors = [err0];
      } else {
        vErrors.push(err0);
      }
      errors++;
    }
    if (data.sourceMonoNs === void 0 || !func0.call(data, "sourceMonoNs")) {
      const err1 = {
        instancePath,
        schemaPath: "#/required",
        keyword: "required",
        params: { missingProperty: "sourceMonoNs" },
        message: "must have required property 'sourceMonoNs'",
      };
      if (vErrors === null) {
        vErrors = [err1];
      } else {
        vErrors.push(err1);
      }
      errors++;
    }
    if (
      data.receivedWallTime === void 0 ||
      !func0.call(data, "receivedWallTime")
    ) {
      const err2 = {
        instancePath,
        schemaPath: "#/required",
        keyword: "required",
        params: { missingProperty: "receivedWallTime" },
        message: "must have required property 'receivedWallTime'",
      };
      if (vErrors === null) {
        vErrors = [err2];
      } else {
        vErrors.push(err2);
      }
      errors++;
    }
    if (data.precision === void 0 || !func0.call(data, "precision")) {
      const err3 = {
        instancePath,
        schemaPath: "#/required",
        keyword: "required",
        params: { missingProperty: "precision" },
        message: "must have required property 'precision'",
      };
      if (vErrors === null) {
        vErrors = [err3];
      } else {
        vErrors.push(err3);
      }
      errors++;
    }
    for (const key0 of Object.keys(data)) {
      if (!(
        key0 === "clockId" ||
        key0 === "precision" ||
        key0 === "receivedWallTime" ||
        key0 === "sourceMonoNs" ||
        key0 === "sourceWallTime"
      )) {
        const err4 = {
          instancePath,
          schemaPath: "#/additionalProperties",
          keyword: "additionalProperties",
          params: { additionalProperty: key0 },
          message: "must NOT have additional properties",
        };
        if (vErrors === null) {
          vErrors = [err4];
        } else {
          vErrors.push(err4);
        }
        errors++;
      }
    }
    if (data.clockId !== void 0 && func0.call(data, "clockId")) {
      if (
        !validate26(data.clockId, {
          instancePath: instancePath + "/clockId",
          parentData: data,
          parentDataProperty: "clockId",
          rootData,
        })
      ) {
        vErrors =
          vErrors === null
            ? validate26.errors
            : vErrors.concat(validate26.errors);
        errors = vErrors.length;
      }
    }
    if (data.precision !== void 0 && func0.call(data, "precision")) {
      if (
        !validate145(data.precision, {
          instancePath: instancePath + "/precision",
          parentData: data,
          parentDataProperty: "precision",
          rootData,
        })
      ) {
        vErrors =
          vErrors === null
            ? validate145.errors
            : vErrors.concat(validate145.errors);
        errors = vErrors.length;
      }
    }
    if (
      data.receivedWallTime !== void 0 &&
      func0.call(data, "receivedWallTime")
    ) {
      if (
        !validate154(data.receivedWallTime, {
          instancePath: instancePath + "/receivedWallTime",
          parentData: data,
          parentDataProperty: "receivedWallTime",
          rootData,
        })
      ) {
        vErrors =
          vErrors === null
            ? validate154.errors
            : vErrors.concat(validate154.errors);
        errors = vErrors.length;
      }
    }
    if (data.sourceMonoNs !== void 0 && func0.call(data, "sourceMonoNs")) {
      if (
        !validate23(data.sourceMonoNs, {
          instancePath: instancePath + "/sourceMonoNs",
          parentData: data,
          parentDataProperty: "sourceMonoNs",
          rootData,
        })
      ) {
        vErrors =
          vErrors === null
            ? validate23.errors
            : vErrors.concat(validate23.errors);
        errors = vErrors.length;
      }
    }
    if (data.sourceWallTime !== void 0 && func0.call(data, "sourceWallTime")) {
      if (
        !validate154(data.sourceWallTime, {
          instancePath: instancePath + "/sourceWallTime",
          parentData: data,
          parentDataProperty: "sourceWallTime",
          rootData,
        })
      ) {
        vErrors =
          vErrors === null
            ? validate154.errors
            : vErrors.concat(validate154.errors);
        errors = vErrors.length;
      }
    }
  } else {
    const err5 = {
      instancePath,
      schemaPath: "#/type",
      keyword: "type",
      params: { type: "object" },
      message: "must be object",
    };
    if (vErrors === null) {
      vErrors = [err5];
    } else {
      vErrors.push(err5);
    }
    errors++;
  }
  validate143.errors = vErrors;
  return errors === 0;
}
function validate78(
  data,
  { instancePath = "", parentData, parentDataProperty, rootData = data } = {},
) {
  let vErrors = null;
  let errors = 0;
  const _errs1 = errors;
  let valid0 = false;
  let passing0 = null;
  const _errs2 = errors;
  if (data && typeof data == "object" && !Array.isArray(data)) {
    if (data.kind === void 0 || !func0.call(data, "kind")) {
      const err0 = {
        instancePath,
        schemaPath: "#/oneOf/0/required",
        keyword: "required",
        params: { missingProperty: "kind" },
        message: "must have required property 'kind'",
      };
      if (vErrors === null) {
        vErrors = [err0];
      } else {
        vErrors.push(err0);
      }
      errors++;
    }
    if (data.payload === void 0 || !func0.call(data, "payload")) {
      const err1 = {
        instancePath,
        schemaPath: "#/oneOf/0/required",
        keyword: "required",
        params: { missingProperty: "payload" },
        message: "must have required property 'payload'",
      };
      if (vErrors === null) {
        vErrors = [err1];
      } else {
        vErrors.push(err1);
      }
      errors++;
    }
    if (data.kind !== void 0 && func0.call(data, "kind")) {
      let data0 = data.kind;
      if (typeof data0 !== "string") {
        const err2 = {
          instancePath: instancePath + "/kind",
          schemaPath: "#/oneOf/0/properties/kind/type",
          keyword: "type",
          params: { type: "string" },
          message: "must be string",
        };
        if (vErrors === null) {
          vErrors = [err2];
        } else {
          vErrors.push(err2);
        }
        errors++;
      }
      if ("rx" !== data0) {
        const err3 = {
          instancePath: instancePath + "/kind",
          schemaPath: "#/oneOf/0/properties/kind/const",
          keyword: "const",
          params: { allowedValue: "rx" },
          message: "must be equal to constant",
        };
        if (vErrors === null) {
          vErrors = [err3];
        } else {
          vErrors.push(err3);
        }
        errors++;
      }
    }
    if (data.payload !== void 0 && func0.call(data, "payload")) {
      if (
        !validate79(data.payload, {
          instancePath: instancePath + "/payload",
          parentData: data,
          parentDataProperty: "payload",
          rootData,
        })
      ) {
        vErrors =
          vErrors === null
            ? validate79.errors
            : vErrors.concat(validate79.errors);
        errors = vErrors.length;
      }
    }
  } else {
    const err4 = {
      instancePath,
      schemaPath: "#/oneOf/0/type",
      keyword: "type",
      params: { type: "object" },
      message: "must be object",
    };
    if (vErrors === null) {
      vErrors = [err4];
    } else {
      vErrors.push(err4);
    }
    errors++;
  }
  var _valid0 = _errs2 === errors;
  if (_valid0) {
    valid0 = true;
    passing0 = 0;
  }
  const _errs7 = errors;
  if (data && typeof data == "object" && !Array.isArray(data)) {
    if (data.kind === void 0 || !func0.call(data, "kind")) {
      const err5 = {
        instancePath,
        schemaPath: "#/oneOf/1/required",
        keyword: "required",
        params: { missingProperty: "kind" },
        message: "must have required property 'kind'",
      };
      if (vErrors === null) {
        vErrors = [err5];
      } else {
        vErrors.push(err5);
      }
      errors++;
    }
    if (data.payload === void 0 || !func0.call(data, "payload")) {
      const err6 = {
        instancePath,
        schemaPath: "#/oneOf/1/required",
        keyword: "required",
        params: { missingProperty: "payload" },
        message: "must have required property 'payload'",
      };
      if (vErrors === null) {
        vErrors = [err6];
      } else {
        vErrors.push(err6);
      }
      errors++;
    }
    if (data.kind !== void 0 && func0.call(data, "kind")) {
      let data2 = data.kind;
      if (typeof data2 !== "string") {
        const err7 = {
          instancePath: instancePath + "/kind",
          schemaPath: "#/oneOf/1/properties/kind/type",
          keyword: "type",
          params: { type: "string" },
          message: "must be string",
        };
        if (vErrors === null) {
          vErrors = [err7];
        } else {
          vErrors.push(err7);
        }
        errors++;
      }
      if ("tx_intent" !== data2) {
        const err8 = {
          instancePath: instancePath + "/kind",
          schemaPath: "#/oneOf/1/properties/kind/const",
          keyword: "const",
          params: { allowedValue: "tx_intent" },
          message: "must be equal to constant",
        };
        if (vErrors === null) {
          vErrors = [err8];
        } else {
          vErrors.push(err8);
        }
        errors++;
      }
    }
    if (data.payload !== void 0 && func0.call(data, "payload")) {
      if (
        !validate90(data.payload, {
          instancePath: instancePath + "/payload",
          parentData: data,
          parentDataProperty: "payload",
          rootData,
        })
      ) {
        vErrors =
          vErrors === null
            ? validate90.errors
            : vErrors.concat(validate90.errors);
        errors = vErrors.length;
      }
    }
  } else {
    const err9 = {
      instancePath,
      schemaPath: "#/oneOf/1/type",
      keyword: "type",
      params: { type: "object" },
      message: "must be object",
    };
    if (vErrors === null) {
      vErrors = [err9];
    } else {
      vErrors.push(err9);
    }
    errors++;
  }
  var _valid0 = _errs7 === errors;
  if (_valid0 && valid0) {
    valid0 = false;
    passing0 = [passing0, 1];
  } else {
    if (_valid0) {
      valid0 = true;
      passing0 = 1;
    }
    const _errs12 = errors;
    if (data && typeof data == "object" && !Array.isArray(data)) {
      if (data.kind === void 0 || !func0.call(data, "kind")) {
        const err10 = {
          instancePath,
          schemaPath: "#/oneOf/2/required",
          keyword: "required",
          params: { missingProperty: "kind" },
          message: "must have required property 'kind'",
        };
        if (vErrors === null) {
          vErrors = [err10];
        } else {
          vErrors.push(err10);
        }
        errors++;
      }
      if (data.payload === void 0 || !func0.call(data, "payload")) {
        const err11 = {
          instancePath,
          schemaPath: "#/oneOf/2/required",
          keyword: "required",
          params: { missingProperty: "payload" },
          message: "must have required property 'payload'",
        };
        if (vErrors === null) {
          vErrors = [err11];
        } else {
          vErrors.push(err11);
        }
        errors++;
      }
      if (data.kind !== void 0 && func0.call(data, "kind")) {
        let data4 = data.kind;
        if (typeof data4 !== "string") {
          const err12 = {
            instancePath: instancePath + "/kind",
            schemaPath: "#/oneOf/2/properties/kind/type",
            keyword: "type",
            params: { type: "string" },
            message: "must be string",
          };
          if (vErrors === null) {
            vErrors = [err12];
          } else {
            vErrors.push(err12);
          }
          errors++;
        }
        if ("tx" !== data4) {
          const err13 = {
            instancePath: instancePath + "/kind",
            schemaPath: "#/oneOf/2/properties/kind/const",
            keyword: "const",
            params: { allowedValue: "tx" },
            message: "must be equal to constant",
          };
          if (vErrors === null) {
            vErrors = [err13];
          } else {
            vErrors.push(err13);
          }
          errors++;
        }
      }
      if (data.payload !== void 0 && func0.call(data, "payload")) {
        if (
          !validate96(data.payload, {
            instancePath: instancePath + "/payload",
            parentData: data,
            parentDataProperty: "payload",
            rootData,
          })
        ) {
          vErrors =
            vErrors === null
              ? validate96.errors
              : vErrors.concat(validate96.errors);
          errors = vErrors.length;
        }
      }
    } else {
      const err14 = {
        instancePath,
        schemaPath: "#/oneOf/2/type",
        keyword: "type",
        params: { type: "object" },
        message: "must be object",
      };
      if (vErrors === null) {
        vErrors = [err14];
      } else {
        vErrors.push(err14);
      }
      errors++;
    }
    var _valid0 = _errs12 === errors;
    if (_valid0 && valid0) {
      valid0 = false;
      passing0 = [passing0, 2];
    } else {
      if (_valid0) {
        valid0 = true;
        passing0 = 2;
      }
      const _errs17 = errors;
      if (data && typeof data == "object" && !Array.isArray(data)) {
        if (data.kind === void 0 || !func0.call(data, "kind")) {
          const err15 = {
            instancePath,
            schemaPath: "#/oneOf/3/required",
            keyword: "required",
            params: { missingProperty: "kind" },
            message: "must have required property 'kind'",
          };
          if (vErrors === null) {
            vErrors = [err15];
          } else {
            vErrors.push(err15);
          }
          errors++;
        }
        if (data.payload === void 0 || !func0.call(data, "payload")) {
          const err16 = {
            instancePath,
            schemaPath: "#/oneOf/3/required",
            keyword: "required",
            params: { missingProperty: "payload" },
            message: "must have required property 'payload'",
          };
          if (vErrors === null) {
            vErrors = [err16];
          } else {
            vErrors.push(err16);
          }
          errors++;
        }
        if (data.kind !== void 0 && func0.call(data, "kind")) {
          let data6 = data.kind;
          if (typeof data6 !== "string") {
            const err17 = {
              instancePath: instancePath + "/kind",
              schemaPath: "#/oneOf/3/properties/kind/type",
              keyword: "type",
              params: { type: "string" },
              message: "must be string",
            };
            if (vErrors === null) {
              vErrors = [err17];
            } else {
              vErrors.push(err17);
            }
            errors++;
          }
          if ("gap" !== data6) {
            const err18 = {
              instancePath: instancePath + "/kind",
              schemaPath: "#/oneOf/3/properties/kind/const",
              keyword: "const",
              params: { allowedValue: "gap" },
              message: "must be equal to constant",
            };
            if (vErrors === null) {
              vErrors = [err18];
            } else {
              vErrors.push(err18);
            }
            errors++;
          }
        }
        if (data.payload !== void 0 && func0.call(data, "payload")) {
          if (
            !validate118(data.payload, {
              instancePath: instancePath + "/payload",
              parentData: data,
              parentDataProperty: "payload",
              rootData,
            })
          ) {
            vErrors =
              vErrors === null
                ? validate118.errors
                : vErrors.concat(validate118.errors);
            errors = vErrors.length;
          }
        }
      } else {
        const err19 = {
          instancePath,
          schemaPath: "#/oneOf/3/type",
          keyword: "type",
          params: { type: "object" },
          message: "must be object",
        };
        if (vErrors === null) {
          vErrors = [err19];
        } else {
          vErrors.push(err19);
        }
        errors++;
      }
      var _valid0 = _errs17 === errors;
      if (_valid0 && valid0) {
        valid0 = false;
        passing0 = [passing0, 3];
      } else {
        if (_valid0) {
          valid0 = true;
          passing0 = 3;
        }
        const _errs22 = errors;
        if (data && typeof data == "object" && !Array.isArray(data)) {
          if (data.kind === void 0 || !func0.call(data, "kind")) {
            const err20 = {
              instancePath,
              schemaPath: "#/oneOf/4/required",
              keyword: "required",
              params: { missingProperty: "kind" },
              message: "must have required property 'kind'",
            };
            if (vErrors === null) {
              vErrors = [err20];
            } else {
              vErrors.push(err20);
            }
            errors++;
          }
          if (data.payload === void 0 || !func0.call(data, "payload")) {
            const err21 = {
              instancePath,
              schemaPath: "#/oneOf/4/required",
              keyword: "required",
              params: { missingProperty: "payload" },
              message: "must have required property 'payload'",
            };
            if (vErrors === null) {
              vErrors = [err21];
            } else {
              vErrors.push(err21);
            }
            errors++;
          }
          if (data.kind !== void 0 && func0.call(data, "kind")) {
            let data8 = data.kind;
            if (typeof data8 !== "string") {
              const err22 = {
                instancePath: instancePath + "/kind",
                schemaPath: "#/oneOf/4/properties/kind/type",
                keyword: "type",
                params: { type: "string" },
                message: "must be string",
              };
              if (vErrors === null) {
                vErrors = [err22];
              } else {
                vErrors.push(err22);
              }
              errors++;
            }
            if ("configuration_boundary" !== data8) {
              const err23 = {
                instancePath: instancePath + "/kind",
                schemaPath: "#/oneOf/4/properties/kind/const",
                keyword: "const",
                params: { allowedValue: "configuration_boundary" },
                message: "must be equal to constant",
              };
              if (vErrors === null) {
                vErrors = [err23];
              } else {
                vErrors.push(err23);
              }
              errors++;
            }
          }
          if (data.payload !== void 0 && func0.call(data, "payload")) {
            if (
              !validate129(data.payload, {
                instancePath: instancePath + "/payload",
                parentData: data,
                parentDataProperty: "payload",
                rootData,
              })
            ) {
              vErrors =
                vErrors === null
                  ? validate129.errors
                  : vErrors.concat(validate129.errors);
              errors = vErrors.length;
            }
          }
        } else {
          const err24 = {
            instancePath,
            schemaPath: "#/oneOf/4/type",
            keyword: "type",
            params: { type: "object" },
            message: "must be object",
          };
          if (vErrors === null) {
            vErrors = [err24];
          } else {
            vErrors.push(err24);
          }
          errors++;
        }
        var _valid0 = _errs22 === errors;
        if (_valid0 && valid0) {
          valid0 = false;
          passing0 = [passing0, 4];
        } else {
          if (_valid0) {
            valid0 = true;
            passing0 = 4;
          }
          const _errs27 = errors;
          if (data && typeof data == "object" && !Array.isArray(data)) {
            if (data.kind === void 0 || !func0.call(data, "kind")) {
              const err25 = {
                instancePath,
                schemaPath: "#/oneOf/5/required",
                keyword: "required",
                params: { missingProperty: "kind" },
                message: "must have required property 'kind'",
              };
              if (vErrors === null) {
                vErrors = [err25];
              } else {
                vErrors.push(err25);
              }
              errors++;
            }
            if (data.payload === void 0 || !func0.call(data, "payload")) {
              const err26 = {
                instancePath,
                schemaPath: "#/oneOf/5/required",
                keyword: "required",
                params: { missingProperty: "payload" },
                message: "must have required property 'payload'",
              };
              if (vErrors === null) {
                vErrors = [err26];
              } else {
                vErrors.push(err26);
              }
              errors++;
            }
            if (data.kind !== void 0 && func0.call(data, "kind")) {
              let data10 = data.kind;
              if (typeof data10 !== "string") {
                const err27 = {
                  instancePath: instancePath + "/kind",
                  schemaPath: "#/oneOf/5/properties/kind/type",
                  keyword: "type",
                  params: { type: "string" },
                  message: "must be string",
                };
                if (vErrors === null) {
                  vErrors = [err27];
                } else {
                  vErrors.push(err27);
                }
                errors++;
              }
              if ("lifecycle" !== data10) {
                const err28 = {
                  instancePath: instancePath + "/kind",
                  schemaPath: "#/oneOf/5/properties/kind/const",
                  keyword: "const",
                  params: { allowedValue: "lifecycle" },
                  message: "must be equal to constant",
                };
                if (vErrors === null) {
                  vErrors = [err28];
                } else {
                  vErrors.push(err28);
                }
                errors++;
              }
            }
            if (data.payload !== void 0 && func0.call(data, "payload")) {
              let data11 = data.payload;
              if (
                data11 &&
                typeof data11 == "object" &&
                !Array.isArray(data11)
              ) {
                for (const key0 of Object.keys(data11)) {
                  if (
                    !validate52(data11[key0], {
                      instancePath:
                        instancePath +
                        "/payload/" +
                        key0.replace(/~/g, "~0").replace(/\//g, "~1"),
                      parentData: data11,
                      parentDataProperty: key0,
                      rootData,
                    })
                  ) {
                    vErrors =
                      vErrors === null
                        ? validate52.errors
                        : vErrors.concat(validate52.errors);
                    errors = vErrors.length;
                  }
                }
              } else {
                const err29 = {
                  instancePath: instancePath + "/payload",
                  schemaPath: "#/oneOf/5/properties/payload/type",
                  keyword: "type",
                  params: { type: "object" },
                  message: "must be object",
                };
                if (vErrors === null) {
                  vErrors = [err29];
                } else {
                  vErrors.push(err29);
                }
                errors++;
              }
            }
          } else {
            const err30 = {
              instancePath,
              schemaPath: "#/oneOf/5/type",
              keyword: "type",
              params: { type: "object" },
              message: "must be object",
            };
            if (vErrors === null) {
              vErrors = [err30];
            } else {
              vErrors.push(err30);
            }
            errors++;
          }
          var _valid0 = _errs27 === errors;
          if (_valid0 && valid0) {
            valid0 = false;
            passing0 = [passing0, 5];
          } else {
            if (_valid0) {
              valid0 = true;
              passing0 = 5;
            }
            const _errs35 = errors;
            if (data && typeof data == "object" && !Array.isArray(data)) {
              if (data.kind === void 0 || !func0.call(data, "kind")) {
                const err31 = {
                  instancePath,
                  schemaPath: "#/oneOf/6/required",
                  keyword: "required",
                  params: { missingProperty: "kind" },
                  message: "must have required property 'kind'",
                };
                if (vErrors === null) {
                  vErrors = [err31];
                } else {
                  vErrors.push(err31);
                }
                errors++;
              }
              if (data.payload === void 0 || !func0.call(data, "payload")) {
                const err32 = {
                  instancePath,
                  schemaPath: "#/oneOf/6/required",
                  keyword: "required",
                  params: { missingProperty: "payload" },
                  message: "must have required property 'payload'",
                };
                if (vErrors === null) {
                  vErrors = [err32];
                } else {
                  vErrors.push(err32);
                }
                errors++;
              }
              if (data.kind !== void 0 && func0.call(data, "kind")) {
                let data13 = data.kind;
                if (typeof data13 !== "string") {
                  const err33 = {
                    instancePath: instancePath + "/kind",
                    schemaPath: "#/oneOf/6/properties/kind/type",
                    keyword: "type",
                    params: { type: "string" },
                    message: "must be string",
                  };
                  if (vErrors === null) {
                    vErrors = [err33];
                  } else {
                    vErrors.push(err33);
                  }
                  errors++;
                }
                if ("control" !== data13) {
                  const err34 = {
                    instancePath: instancePath + "/kind",
                    schemaPath: "#/oneOf/6/properties/kind/const",
                    keyword: "const",
                    params: { allowedValue: "control" },
                    message: "must be equal to constant",
                  };
                  if (vErrors === null) {
                    vErrors = [err34];
                  } else {
                    vErrors.push(err34);
                  }
                  errors++;
                }
              }
              if (data.payload !== void 0 && func0.call(data, "payload")) {
                let data14 = data.payload;
                if (
                  data14 &&
                  typeof data14 == "object" &&
                  !Array.isArray(data14)
                ) {
                  for (const key1 of Object.keys(data14)) {
                    if (
                      !validate52(data14[key1], {
                        instancePath:
                          instancePath +
                          "/payload/" +
                          key1.replace(/~/g, "~0").replace(/\//g, "~1"),
                        parentData: data14,
                        parentDataProperty: key1,
                        rootData,
                      })
                    ) {
                      vErrors =
                        vErrors === null
                          ? validate52.errors
                          : vErrors.concat(validate52.errors);
                      errors = vErrors.length;
                    }
                  }
                } else {
                  const err35 = {
                    instancePath: instancePath + "/payload",
                    schemaPath: "#/oneOf/6/properties/payload/type",
                    keyword: "type",
                    params: { type: "object" },
                    message: "must be object",
                  };
                  if (vErrors === null) {
                    vErrors = [err35];
                  } else {
                    vErrors.push(err35);
                  }
                  errors++;
                }
              }
            } else {
              const err36 = {
                instancePath,
                schemaPath: "#/oneOf/6/type",
                keyword: "type",
                params: { type: "object" },
                message: "must be object",
              };
              if (vErrors === null) {
                vErrors = [err36];
              } else {
                vErrors.push(err36);
              }
              errors++;
            }
            var _valid0 = _errs35 === errors;
            if (_valid0 && valid0) {
              valid0 = false;
              passing0 = [passing0, 6];
            } else {
              if (_valid0) {
                valid0 = true;
                passing0 = 6;
              }
            }
          }
        }
      }
    }
  }
  if (!valid0) {
    const err37 = {
      instancePath,
      schemaPath: "#/oneOf",
      keyword: "oneOf",
      params: { passingSchemas: passing0 },
      message: "must match exactly one schema in oneOf",
    };
    if (vErrors === null) {
      vErrors = [err37];
    } else {
      vErrors.push(err37);
    }
    errors++;
  } else {
    errors = _errs1;
    if (vErrors !== null) {
      if (_errs1) {
        vErrors.length = _errs1;
      } else {
        vErrors = null;
      }
    }
  }
  if (data && typeof data == "object" && !Array.isArray(data)) {
    if (data.hostId === void 0 || !func0.call(data, "hostId")) {
      const err38 = {
        instancePath,
        schemaPath: "#/required",
        keyword: "required",
        params: { missingProperty: "hostId" },
        message: "must have required property 'hostId'",
      };
      if (vErrors === null) {
        vErrors = [err38];
      } else {
        vErrors.push(err38);
      }
      errors++;
    }
    if (data.instanceEpoch === void 0 || !func0.call(data, "instanceEpoch")) {
      const err39 = {
        instancePath,
        schemaPath: "#/required",
        keyword: "required",
        params: { missingProperty: "instanceEpoch" },
        message: "must have required property 'instanceEpoch'",
      };
      if (vErrors === null) {
        vErrors = [err39];
      } else {
        vErrors.push(err39);
      }
      errors++;
    }
    if (data.sessionId === void 0 || !func0.call(data, "sessionId")) {
      const err40 = {
        instancePath,
        schemaPath: "#/required",
        keyword: "required",
        params: { missingProperty: "sessionId" },
        message: "must have required property 'sessionId'",
      };
      if (vErrors === null) {
        vErrors = [err40];
      } else {
        vErrors.push(err40);
      }
      errors++;
    }
    if (data.sessionEpoch === void 0 || !func0.call(data, "sessionEpoch")) {
      const err41 = {
        instancePath,
        schemaPath: "#/required",
        keyword: "required",
        params: { missingProperty: "sessionEpoch" },
        message: "must have required property 'sessionEpoch'",
      };
      if (vErrors === null) {
        vErrors = [err41];
      } else {
        vErrors.push(err41);
      }
      errors++;
    }
    if (data.eventSeq === void 0 || !func0.call(data, "eventSeq")) {
      const err42 = {
        instancePath,
        schemaPath: "#/required",
        keyword: "required",
        params: { missingProperty: "eventSeq" },
        message: "must have required property 'eventSeq'",
      };
      if (vErrors === null) {
        vErrors = [err42];
      } else {
        vErrors.push(err42);
      }
      errors++;
    }
    if (
      data.configurationRevision === void 0 ||
      !func0.call(data, "configurationRevision")
    ) {
      const err43 = {
        instancePath,
        schemaPath: "#/required",
        keyword: "required",
        params: { missingProperty: "configurationRevision" },
        message: "must have required property 'configurationRevision'",
      };
      if (vErrors === null) {
        vErrors = [err43];
      } else {
        vErrors.push(err43);
      }
      errors++;
    }
    if (data.time === void 0 || !func0.call(data, "time")) {
      const err44 = {
        instancePath,
        schemaPath: "#/required",
        keyword: "required",
        params: { missingProperty: "time" },
        message: "must have required property 'time'",
      };
      if (vErrors === null) {
        vErrors = [err44];
      } else {
        vErrors.push(err44);
      }
      errors++;
    }
    for (const key2 of Object.keys(data)) {
      if (!func0.call(schema26.properties, key2)) {
        const err45 = {
          instancePath,
          schemaPath: "#/additionalProperties",
          keyword: "additionalProperties",
          params: { additionalProperty: key2 },
          message: "must NOT have additional properties",
        };
        if (vErrors === null) {
          vErrors = [err45];
        } else {
          vErrors.push(err45);
        }
        errors++;
      }
    }
    if (
      data.configurationRevision !== void 0 &&
      func0.call(data, "configurationRevision")
    ) {
      if (
        !validate23(data.configurationRevision, {
          instancePath: instancePath + "/configurationRevision",
          parentData: data,
          parentDataProperty: "configurationRevision",
          rootData,
        })
      ) {
        vErrors =
          vErrors === null
            ? validate23.errors
            : vErrors.concat(validate23.errors);
        errors = vErrors.length;
      }
    }
    if (data.eventSeq !== void 0 && func0.call(data, "eventSeq")) {
      if (
        !validate23(data.eventSeq, {
          instancePath: instancePath + "/eventSeq",
          parentData: data,
          parentDataProperty: "eventSeq",
          rootData,
        })
      ) {
        vErrors =
          vErrors === null
            ? validate23.errors
            : vErrors.concat(validate23.errors);
        errors = vErrors.length;
      }
    }
    if (data.hostId !== void 0 && func0.call(data, "hostId")) {
      if (
        !validate26(data.hostId, {
          instancePath: instancePath + "/hostId",
          parentData: data,
          parentDataProperty: "hostId",
          rootData,
        })
      ) {
        vErrors =
          vErrors === null
            ? validate26.errors
            : vErrors.concat(validate26.errors);
        errors = vErrors.length;
      }
    }
    if (data.instanceEpoch !== void 0 && func0.call(data, "instanceEpoch")) {
      if (
        !validate23(data.instanceEpoch, {
          instancePath: instancePath + "/instanceEpoch",
          parentData: data,
          parentDataProperty: "instanceEpoch",
          rootData,
        })
      ) {
        vErrors =
          vErrors === null
            ? validate23.errors
            : vErrors.concat(validate23.errors);
        errors = vErrors.length;
      }
    }
    if (data.sessionEpoch !== void 0 && func0.call(data, "sessionEpoch")) {
      if (
        !validate23(data.sessionEpoch, {
          instancePath: instancePath + "/sessionEpoch",
          parentData: data,
          parentDataProperty: "sessionEpoch",
          rootData,
        })
      ) {
        vErrors =
          vErrors === null
            ? validate23.errors
            : vErrors.concat(validate23.errors);
        errors = vErrors.length;
      }
    }
    if (data.sessionId !== void 0 && func0.call(data, "sessionId")) {
      if (
        !validate26(data.sessionId, {
          instancePath: instancePath + "/sessionId",
          parentData: data,
          parentDataProperty: "sessionId",
          rootData,
        })
      ) {
        vErrors =
          vErrors === null
            ? validate26.errors
            : vErrors.concat(validate26.errors);
        errors = vErrors.length;
      }
    }
    if (data.time !== void 0 && func0.call(data, "time")) {
      if (
        !validate143(data.time, {
          instancePath: instancePath + "/time",
          parentData: data,
          parentDataProperty: "time",
          rootData,
        })
      ) {
        vErrors =
          vErrors === null
            ? validate143.errors
            : vErrors.concat(validate143.errors);
        errors = vErrors.length;
      }
    }
  } else {
    const err46 = {
      instancePath,
      schemaPath: "#/type",
      keyword: "type",
      params: { type: "object" },
      message: "must be object",
    };
    if (vErrors === null) {
      vErrors = [err46];
    } else {
      vErrors.push(err46);
    }
    errors++;
  }
  validate78.errors = vErrors;
  return errors === 0;
}
var schema47 = {
  enum: [
    "reader_overflow",
    "capture_overflow",
    "capture_paused",
    "network_loss",
  ],
  type: "string",
};
function validate165(
  data,
  { instancePath = "", parentData, parentDataProperty, rootData = data } = {},
) {
  let vErrors = null;
  let errors = 0;
  if (typeof data !== "string") {
    const err0 = {
      instancePath,
      schemaPath: "#/type",
      keyword: "type",
      params: { type: "string" },
      message: "must be string",
    };
    if (vErrors === null) {
      vErrors = [err0];
    } else {
      vErrors.push(err0);
    }
    errors++;
  }
  if (!(
    data === "reader_overflow" ||
    data === "capture_overflow" ||
    data === "capture_paused" ||
    data === "network_loss"
  )) {
    const err1 = {
      instancePath,
      schemaPath: "#/enum",
      keyword: "enum",
      params: { allowedValues: schema47.enum },
      message: "must be equal to one of the allowed values",
    };
    if (vErrors === null) {
      vErrors = [err1];
    } else {
      vErrors.push(err1);
    }
    errors++;
  }
  validate165.errors = vErrors;
  return errors === 0;
}
function validate160(
  data,
  { instancePath = "", parentData, parentDataProperty, rootData = data } = {},
) {
  let vErrors = null;
  let errors = 0;
  if (data && typeof data == "object" && !Array.isArray(data)) {
    if (data.hostId === void 0 || !func0.call(data, "hostId")) {
      const err0 = {
        instancePath,
        schemaPath: "#/required",
        keyword: "required",
        params: { missingProperty: "hostId" },
        message: "must have required property 'hostId'",
      };
      if (vErrors === null) {
        vErrors = [err0];
      } else {
        vErrors.push(err0);
      }
      errors++;
    }
    if (data.instanceEpoch === void 0 || !func0.call(data, "instanceEpoch")) {
      const err1 = {
        instancePath,
        schemaPath: "#/required",
        keyword: "required",
        params: { missingProperty: "instanceEpoch" },
        message: "must have required property 'instanceEpoch'",
      };
      if (vErrors === null) {
        vErrors = [err1];
      } else {
        vErrors.push(err1);
      }
      errors++;
    }
    if (data.sessionId === void 0 || !func0.call(data, "sessionId")) {
      const err2 = {
        instancePath,
        schemaPath: "#/required",
        keyword: "required",
        params: { missingProperty: "sessionId" },
        message: "must have required property 'sessionId'",
      };
      if (vErrors === null) {
        vErrors = [err2];
      } else {
        vErrors.push(err2);
      }
      errors++;
    }
    if (data.sessionEpoch === void 0 || !func0.call(data, "sessionEpoch")) {
      const err3 = {
        instancePath,
        schemaPath: "#/required",
        keyword: "required",
        params: { missingProperty: "sessionEpoch" },
        message: "must have required property 'sessionEpoch'",
      };
      if (vErrors === null) {
        vErrors = [err3];
      } else {
        vErrors.push(err3);
      }
      errors++;
    }
    if (data.reason === void 0 || !func0.call(data, "reason")) {
      const err4 = {
        instancePath,
        schemaPath: "#/required",
        keyword: "required",
        params: { missingProperty: "reason" },
        message: "must have required property 'reason'",
      };
      if (vErrors === null) {
        vErrors = [err4];
      } else {
        vErrors.push(err4);
      }
      errors++;
    }
    if (
      data.missingEventRange === void 0 ||
      !func0.call(data, "missingEventRange")
    ) {
      const err5 = {
        instancePath,
        schemaPath: "#/required",
        keyword: "required",
        params: { missingProperty: "missingEventRange" },
        message: "must have required property 'missingEventRange'",
      };
      if (vErrors === null) {
        vErrors = [err5];
      } else {
        vErrors.push(err5);
      }
      errors++;
    }
    for (const key0 of Object.keys(data)) {
      if (!(
        key0 === "hostId" ||
        key0 === "instanceEpoch" ||
        key0 === "missingByteRanges" ||
        key0 === "missingEventRange" ||
        key0 === "reason" ||
        key0 === "sessionEpoch" ||
        key0 === "sessionId"
      )) {
        const err6 = {
          instancePath,
          schemaPath: "#/additionalProperties",
          keyword: "additionalProperties",
          params: { additionalProperty: key0 },
          message: "must NOT have additional properties",
        };
        if (vErrors === null) {
          vErrors = [err6];
        } else {
          vErrors.push(err6);
        }
        errors++;
      }
    }
    if (data.hostId !== void 0 && func0.call(data, "hostId")) {
      if (
        !validate26(data.hostId, {
          instancePath: instancePath + "/hostId",
          parentData: data,
          parentDataProperty: "hostId",
          rootData,
        })
      ) {
        vErrors =
          vErrors === null
            ? validate26.errors
            : vErrors.concat(validate26.errors);
        errors = vErrors.length;
      }
    }
    if (data.instanceEpoch !== void 0 && func0.call(data, "instanceEpoch")) {
      if (
        !validate23(data.instanceEpoch, {
          instancePath: instancePath + "/instanceEpoch",
          parentData: data,
          parentDataProperty: "instanceEpoch",
          rootData,
        })
      ) {
        vErrors =
          vErrors === null
            ? validate23.errors
            : vErrors.concat(validate23.errors);
        errors = vErrors.length;
      }
    }
    if (
      data.missingByteRanges !== void 0 &&
      func0.call(data, "missingByteRanges")
    ) {
      let data2 = data.missingByteRanges;
      if (Array.isArray(data2)) {
        const len0 = data2.length;
        for (let i0 = 0; i0 < len0; i0++) {
          if (
            !validate120(data2[i0], {
              instancePath: instancePath + "/missingByteRanges/" + i0,
              parentData: data2,
              parentDataProperty: i0,
              rootData,
            })
          ) {
            vErrors =
              vErrors === null
                ? validate120.errors
                : vErrors.concat(validate120.errors);
            errors = vErrors.length;
          }
        }
      } else {
        const err7 = {
          instancePath: instancePath + "/missingByteRanges",
          schemaPath: "#/properties/missingByteRanges/type",
          keyword: "type",
          params: { type: "array" },
          message: "must be array",
        };
        if (vErrors === null) {
          vErrors = [err7];
        } else {
          vErrors.push(err7);
        }
        errors++;
      }
    }
    if (
      data.missingEventRange !== void 0 &&
      func0.call(data, "missingEventRange")
    ) {
      if (
        !validate97(data.missingEventRange, {
          instancePath: instancePath + "/missingEventRange",
          parentData: data,
          parentDataProperty: "missingEventRange",
          rootData,
        })
      ) {
        vErrors =
          vErrors === null
            ? validate97.errors
            : vErrors.concat(validate97.errors);
        errors = vErrors.length;
      }
    }
    if (data.reason !== void 0 && func0.call(data, "reason")) {
      if (
        !validate165(data.reason, {
          instancePath: instancePath + "/reason",
          parentData: data,
          parentDataProperty: "reason",
          rootData,
        })
      ) {
        vErrors =
          vErrors === null
            ? validate165.errors
            : vErrors.concat(validate165.errors);
        errors = vErrors.length;
      }
    }
    if (data.sessionEpoch !== void 0 && func0.call(data, "sessionEpoch")) {
      if (
        !validate23(data.sessionEpoch, {
          instancePath: instancePath + "/sessionEpoch",
          parentData: data,
          parentDataProperty: "sessionEpoch",
          rootData,
        })
      ) {
        vErrors =
          vErrors === null
            ? validate23.errors
            : vErrors.concat(validate23.errors);
        errors = vErrors.length;
      }
    }
    if (data.sessionId !== void 0 && func0.call(data, "sessionId")) {
      if (
        !validate26(data.sessionId, {
          instancePath: instancePath + "/sessionId",
          parentData: data,
          parentDataProperty: "sessionId",
          rootData,
        })
      ) {
        vErrors =
          vErrors === null
            ? validate26.errors
            : vErrors.concat(validate26.errors);
        errors = vErrors.length;
      }
    }
  } else {
    const err8 = {
      instancePath,
      schemaPath: "#/type",
      keyword: "type",
      params: { type: "object" },
      message: "must be object",
    };
    if (vErrors === null) {
      vErrors = [err8];
    } else {
      vErrors.push(err8);
    }
    errors++;
  }
  validate160.errors = vErrors;
  return errors === 0;
}
function validate77(
  data,
  { instancePath = "", parentData, parentDataProperty, rootData = data } = {},
) {
  let vErrors = null;
  let errors = 0;
  const _errs0 = errors;
  let valid0 = false;
  let passing0 = null;
  const _errs1 = errors;
  if (data && typeof data == "object" && !Array.isArray(data)) {
    if (data.kind === void 0 || !func0.call(data, "kind")) {
      const err0 = {
        instancePath,
        schemaPath: "#/oneOf/0/required",
        keyword: "required",
        params: { missingProperty: "kind" },
        message: "must have required property 'kind'",
      };
      if (vErrors === null) {
        vErrors = [err0];
      } else {
        vErrors.push(err0);
      }
      errors++;
    }
    if (data.event === void 0 || !func0.call(data, "event")) {
      const err1 = {
        instancePath,
        schemaPath: "#/oneOf/0/required",
        keyword: "required",
        params: { missingProperty: "event" },
        message: "must have required property 'event'",
      };
      if (vErrors === null) {
        vErrors = [err1];
      } else {
        vErrors.push(err1);
      }
      errors++;
    }
    for (const key0 of Object.keys(data)) {
      if (!(key0 === "event" || key0 === "kind")) {
        const err2 = {
          instancePath,
          schemaPath: "#/oneOf/0/additionalProperties",
          keyword: "additionalProperties",
          params: { additionalProperty: key0 },
          message: "must NOT have additional properties",
        };
        if (vErrors === null) {
          vErrors = [err2];
        } else {
          vErrors.push(err2);
        }
        errors++;
      }
    }
    if (data.event !== void 0 && func0.call(data, "event")) {
      if (
        !validate78(data.event, {
          instancePath: instancePath + "/event",
          parentData: data,
          parentDataProperty: "event",
          rootData,
        })
      ) {
        vErrors =
          vErrors === null
            ? validate78.errors
            : vErrors.concat(validate78.errors);
        errors = vErrors.length;
      }
    }
    if (data.kind !== void 0 && func0.call(data, "kind")) {
      let data1 = data.kind;
      if (typeof data1 !== "string") {
        const err3 = {
          instancePath: instancePath + "/kind",
          schemaPath: "#/oneOf/0/properties/kind/type",
          keyword: "type",
          params: { type: "string" },
          message: "must be string",
        };
        if (vErrors === null) {
          vErrors = [err3];
        } else {
          vErrors.push(err3);
        }
        errors++;
      }
      if ("source" !== data1) {
        const err4 = {
          instancePath: instancePath + "/kind",
          schemaPath: "#/oneOf/0/properties/kind/const",
          keyword: "const",
          params: { allowedValue: "source" },
          message: "must be equal to constant",
        };
        if (vErrors === null) {
          vErrors = [err4];
        } else {
          vErrors.push(err4);
        }
        errors++;
      }
    }
  } else {
    const err5 = {
      instancePath,
      schemaPath: "#/oneOf/0/type",
      keyword: "type",
      params: { type: "object" },
      message: "must be object",
    };
    if (vErrors === null) {
      vErrors = [err5];
    } else {
      vErrors.push(err5);
    }
    errors++;
  }
  var _valid0 = _errs1 === errors;
  if (_valid0) {
    valid0 = true;
    passing0 = 0;
  }
  const _errs7 = errors;
  if (data && typeof data == "object" && !Array.isArray(data)) {
    if (data.kind === void 0 || !func0.call(data, "kind")) {
      const err6 = {
        instancePath,
        schemaPath: "#/oneOf/1/required",
        keyword: "required",
        params: { missingProperty: "kind" },
        message: "must have required property 'kind'",
      };
      if (vErrors === null) {
        vErrors = [err6];
      } else {
        vErrors.push(err6);
      }
      errors++;
    }
    if (data.gap === void 0 || !func0.call(data, "gap")) {
      const err7 = {
        instancePath,
        schemaPath: "#/oneOf/1/required",
        keyword: "required",
        params: { missingProperty: "gap" },
        message: "must have required property 'gap'",
      };
      if (vErrors === null) {
        vErrors = [err7];
      } else {
        vErrors.push(err7);
      }
      errors++;
    }
    for (const key1 of Object.keys(data)) {
      if (!(key1 === "gap" || key1 === "kind")) {
        const err8 = {
          instancePath,
          schemaPath: "#/oneOf/1/additionalProperties",
          keyword: "additionalProperties",
          params: { additionalProperty: key1 },
          message: "must NOT have additional properties",
        };
        if (vErrors === null) {
          vErrors = [err8];
        } else {
          vErrors.push(err8);
        }
        errors++;
      }
    }
    if (data.gap !== void 0 && func0.call(data, "gap")) {
      if (
        !validate160(data.gap, {
          instancePath: instancePath + "/gap",
          parentData: data,
          parentDataProperty: "gap",
          rootData,
        })
      ) {
        vErrors =
          vErrors === null
            ? validate160.errors
            : vErrors.concat(validate160.errors);
        errors = vErrors.length;
      }
    }
    if (data.kind !== void 0 && func0.call(data, "kind")) {
      let data3 = data.kind;
      if (typeof data3 !== "string") {
        const err9 = {
          instancePath: instancePath + "/kind",
          schemaPath: "#/oneOf/1/properties/kind/type",
          keyword: "type",
          params: { type: "string" },
          message: "must be string",
        };
        if (vErrors === null) {
          vErrors = [err9];
        } else {
          vErrors.push(err9);
        }
        errors++;
      }
      if ("reader_gap" !== data3) {
        const err10 = {
          instancePath: instancePath + "/kind",
          schemaPath: "#/oneOf/1/properties/kind/const",
          keyword: "const",
          params: { allowedValue: "reader_gap" },
          message: "must be equal to constant",
        };
        if (vErrors === null) {
          vErrors = [err10];
        } else {
          vErrors.push(err10);
        }
        errors++;
      }
    }
  } else {
    const err11 = {
      instancePath,
      schemaPath: "#/oneOf/1/type",
      keyword: "type",
      params: { type: "object" },
      message: "must be object",
    };
    if (vErrors === null) {
      vErrors = [err11];
    } else {
      vErrors.push(err11);
    }
    errors++;
  }
  var _valid0 = _errs7 === errors;
  if (_valid0 && valid0) {
    valid0 = false;
    passing0 = [passing0, 1];
  } else {
    if (_valid0) {
      valid0 = true;
      passing0 = 1;
    }
  }
  if (!valid0) {
    const err12 = {
      instancePath,
      schemaPath: "#/oneOf",
      keyword: "oneOf",
      params: { passingSchemas: passing0 },
      message: "must match exactly one schema in oneOf",
    };
    if (vErrors === null) {
      vErrors = [err12];
    } else {
      vErrors.push(err12);
    }
    errors++;
  } else {
    errors = _errs0;
    if (vErrors !== null) {
      if (_errs0) {
        vErrors.length = _errs0;
      } else {
        vErrors = null;
      }
    }
  }
  validate77.errors = vErrors;
  return errors === 0;
}
function validate70(
  data,
  { instancePath = "", parentData, parentDataProperty, rootData = data } = {},
) {
  let vErrors = null;
  let errors = 0;
  if (data && typeof data == "object" && !Array.isArray(data)) {
    if (data.subscriptionId === void 0 || !func0.call(data, "subscriptionId")) {
      const err0 = {
        instancePath,
        schemaPath: "#/required",
        keyword: "required",
        params: { missingProperty: "subscriptionId" },
        message: "must have required property 'subscriptionId'",
      };
      if (vErrors === null) {
        vErrors = [err0];
      } else {
        vErrors.push(err0);
      }
      errors++;
    }
    if (data.cursor === void 0 || !func0.call(data, "cursor")) {
      const err1 = {
        instancePath,
        schemaPath: "#/required",
        keyword: "required",
        params: { missingProperty: "cursor" },
        message: "must have required property 'cursor'",
      };
      if (vErrors === null) {
        vErrors = [err1];
      } else {
        vErrors.push(err1);
      }
      errors++;
    }
    if (data.previousCursor === void 0 || !func0.call(data, "previousCursor")) {
      const err2 = {
        instancePath,
        schemaPath: "#/required",
        keyword: "required",
        params: { missingProperty: "previousCursor" },
        message: "must have required property 'previousCursor'",
      };
      if (vErrors === null) {
        vErrors = [err2];
      } else {
        vErrors.push(err2);
      }
      errors++;
    }
    if (data.items === void 0 || !func0.call(data, "items")) {
      const err3 = {
        instancePath,
        schemaPath: "#/required",
        keyword: "required",
        params: { missingProperty: "items" },
        message: "must have required property 'items'",
      };
      if (vErrors === null) {
        vErrors = [err3];
      } else {
        vErrors.push(err3);
      }
      errors++;
    }
    for (const key0 of Object.keys(data)) {
      if (!(
        key0 === "cursor" ||
        key0 === "items" ||
        key0 === "previousCursor" ||
        key0 === "subscriptionId"
      )) {
        const err4 = {
          instancePath,
          schemaPath: "#/additionalProperties",
          keyword: "additionalProperties",
          params: { additionalProperty: key0 },
          message: "must NOT have additional properties",
        };
        if (vErrors === null) {
          vErrors = [err4];
        } else {
          vErrors.push(err4);
        }
        errors++;
      }
    }
    if (data.cursor !== void 0 && func0.call(data, "cursor")) {
      if (
        !validate71(data.cursor, {
          instancePath: instancePath + "/cursor",
          parentData: data,
          parentDataProperty: "cursor",
          rootData,
        })
      ) {
        vErrors =
          vErrors === null
            ? validate71.errors
            : vErrors.concat(validate71.errors);
        errors = vErrors.length;
      }
    }
    if (data.items !== void 0 && func0.call(data, "items")) {
      let data1 = data.items;
      if (Array.isArray(data1)) {
        if (data1.length < 1) {
          const err5 = {
            instancePath: instancePath + "/items",
            schemaPath: "#/properties/items/minItems",
            keyword: "minItems",
            params: { limit: 1 },
            message: "must NOT have fewer than 1 items",
          };
          if (vErrors === null) {
            vErrors = [err5];
          } else {
            vErrors.push(err5);
          }
          errors++;
        }
        const len0 = data1.length;
        for (let i0 = 0; i0 < len0; i0++) {
          if (
            !validate77(data1[i0], {
              instancePath: instancePath + "/items/" + i0,
              parentData: data1,
              parentDataProperty: i0,
              rootData,
            })
          ) {
            vErrors =
              vErrors === null
                ? validate77.errors
                : vErrors.concat(validate77.errors);
            errors = vErrors.length;
          }
        }
      } else {
        const err6 = {
          instancePath: instancePath + "/items",
          schemaPath: "#/properties/items/type",
          keyword: "type",
          params: { type: "array" },
          message: "must be array",
        };
        if (vErrors === null) {
          vErrors = [err6];
        } else {
          vErrors.push(err6);
        }
        errors++;
      }
    }
    if (data.previousCursor !== void 0 && func0.call(data, "previousCursor")) {
      if (
        !validate71(data.previousCursor, {
          instancePath: instancePath + "/previousCursor",
          parentData: data,
          parentDataProperty: "previousCursor",
          rootData,
        })
      ) {
        vErrors =
          vErrors === null
            ? validate71.errors
            : vErrors.concat(validate71.errors);
        errors = vErrors.length;
      }
    }
    if (data.subscriptionId !== void 0 && func0.call(data, "subscriptionId")) {
      if (
        !validate26(data.subscriptionId, {
          instancePath: instancePath + "/subscriptionId",
          parentData: data,
          parentDataProperty: "subscriptionId",
          rootData,
        })
      ) {
        vErrors =
          vErrors === null
            ? validate26.errors
            : vErrors.concat(validate26.errors);
        errors = vErrors.length;
      }
    }
  } else {
    const err7 = {
      instancePath,
      schemaPath: "#/type",
      keyword: "type",
      params: { type: "object" },
      message: "must be object",
    };
    if (vErrors === null) {
      vErrors = [err7];
    } else {
      vErrors.push(err7);
    }
    errors++;
  }
  validate70.errors = vErrors;
  return errors === 0;
}
var validateRequestId = validate173;
var pattern7 = new RegExp(
  "^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$",
  "u",
);
function validate173(
  data,
  { instancePath = "", parentData, parentDataProperty, rootData = data } = {},
) {
  let vErrors = null;
  let errors = 0;
  if (typeof data === "string") {
    if (!pattern7.test(data)) {
      const err0 = {
        instancePath,
        schemaPath: "#/pattern",
        keyword: "pattern",
        params: {
          pattern:
            "^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$",
        },
        message:
          'must match pattern "^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$"',
      };
      if (vErrors === null) {
        vErrors = [err0];
      } else {
        vErrors.push(err0);
      }
      errors++;
    }
  } else {
    const err1 = {
      instancePath,
      schemaPath: "#/type",
      keyword: "type",
      params: { type: "string" },
      message: "must be string",
    };
    if (vErrors === null) {
      vErrors = [err1];
    } else {
      vErrors.push(err1);
    }
    errors++;
  }
  validate173.errors = vErrors;
  return errors === 0;
}
var validateSessionSnapshot = validate174;
var schema49 = {
  $schema: "http://json-schema.org/draft-07/schema#",
  additionalProperties: false,
  properties: {
    capabilities: {
      $ref: "#/definitions/shared/definitions/TransportCapabilities",
    },
    configuration: {
      $ref: "#/definitions/shared/definitions/SerialConfiguration",
    },
    configurationRevision: { $ref: "#/definitions/shared/definitions/U64" },
    controlState: { $ref: "#/definitions/shared/definitions/ControlState" },
    deviceId: { $ref: "#/definitions/shared/definitions/Id" },
    lease: { $ref: "#/definitions/shared/definitions/Lease" },
    readOnly: { type: "boolean" },
    reconnect: { $ref: "#/definitions/shared/definitions/ReconnectStatus" },
    revision: { $ref: "#/definitions/shared/definitions/U64" },
    sessionEpoch: { $ref: "#/definitions/shared/definitions/U64" },
    sessionId: { $ref: "#/definitions/shared/definitions/Id" },
    state: { $ref: "#/definitions/shared/definitions/SessionState" },
    txGate: { $ref: "#/definitions/shared/definitions/TxGate" },
  },
  required: [
    "sessionId",
    "deviceId",
    "sessionEpoch",
    "revision",
    "configurationRevision",
    "state",
    "configuration",
    "readOnly",
    "txGate",
    "controlState",
    "capabilities",
  ],
  title: "SessionSnapshot",
  type: "object",
};
var schema50 = {
  additionalProperties: false,
  properties: {
    configuration: { type: "boolean" },
    drain: { type: "boolean" },
    dtr: { type: "boolean" },
    finiteBreak: { type: "boolean" },
    purgeRx: { type: "boolean" },
    purgeTx: { type: "boolean" },
    queueStatus: { type: "boolean" },
    rts: { type: "boolean" },
    semantics: { $ref: "#/definitions/shared/definitions/TransportSemantics" },
  },
  required: [
    "semantics",
    "configuration",
    "dtr",
    "rts",
    "finiteBreak",
    "queueStatus",
    "drain",
    "purgeRx",
    "purgeTx",
  ],
  type: "object",
};
var schema51 = { enum: ["stream", "message"], type: "string" };
function validate176(
  data,
  { instancePath = "", parentData, parentDataProperty, rootData = data } = {},
) {
  let vErrors = null;
  let errors = 0;
  if (typeof data !== "string") {
    const err0 = {
      instancePath,
      schemaPath: "#/type",
      keyword: "type",
      params: { type: "string" },
      message: "must be string",
    };
    if (vErrors === null) {
      vErrors = [err0];
    } else {
      vErrors.push(err0);
    }
    errors++;
  }
  if (!(data === "stream" || data === "message")) {
    const err1 = {
      instancePath,
      schemaPath: "#/enum",
      keyword: "enum",
      params: { allowedValues: schema51.enum },
      message: "must be equal to one of the allowed values",
    };
    if (vErrors === null) {
      vErrors = [err1];
    } else {
      vErrors.push(err1);
    }
    errors++;
  }
  validate176.errors = vErrors;
  return errors === 0;
}
function validate175(
  data,
  { instancePath = "", parentData, parentDataProperty, rootData = data } = {},
) {
  let vErrors = null;
  let errors = 0;
  if (data && typeof data == "object" && !Array.isArray(data)) {
    if (data.semantics === void 0 || !func0.call(data, "semantics")) {
      const err0 = {
        instancePath,
        schemaPath: "#/required",
        keyword: "required",
        params: { missingProperty: "semantics" },
        message: "must have required property 'semantics'",
      };
      if (vErrors === null) {
        vErrors = [err0];
      } else {
        vErrors.push(err0);
      }
      errors++;
    }
    if (data.configuration === void 0 || !func0.call(data, "configuration")) {
      const err1 = {
        instancePath,
        schemaPath: "#/required",
        keyword: "required",
        params: { missingProperty: "configuration" },
        message: "must have required property 'configuration'",
      };
      if (vErrors === null) {
        vErrors = [err1];
      } else {
        vErrors.push(err1);
      }
      errors++;
    }
    if (data.dtr === void 0 || !func0.call(data, "dtr")) {
      const err2 = {
        instancePath,
        schemaPath: "#/required",
        keyword: "required",
        params: { missingProperty: "dtr" },
        message: "must have required property 'dtr'",
      };
      if (vErrors === null) {
        vErrors = [err2];
      } else {
        vErrors.push(err2);
      }
      errors++;
    }
    if (data.rts === void 0 || !func0.call(data, "rts")) {
      const err3 = {
        instancePath,
        schemaPath: "#/required",
        keyword: "required",
        params: { missingProperty: "rts" },
        message: "must have required property 'rts'",
      };
      if (vErrors === null) {
        vErrors = [err3];
      } else {
        vErrors.push(err3);
      }
      errors++;
    }
    if (data.finiteBreak === void 0 || !func0.call(data, "finiteBreak")) {
      const err4 = {
        instancePath,
        schemaPath: "#/required",
        keyword: "required",
        params: { missingProperty: "finiteBreak" },
        message: "must have required property 'finiteBreak'",
      };
      if (vErrors === null) {
        vErrors = [err4];
      } else {
        vErrors.push(err4);
      }
      errors++;
    }
    if (data.queueStatus === void 0 || !func0.call(data, "queueStatus")) {
      const err5 = {
        instancePath,
        schemaPath: "#/required",
        keyword: "required",
        params: { missingProperty: "queueStatus" },
        message: "must have required property 'queueStatus'",
      };
      if (vErrors === null) {
        vErrors = [err5];
      } else {
        vErrors.push(err5);
      }
      errors++;
    }
    if (data.drain === void 0 || !func0.call(data, "drain")) {
      const err6 = {
        instancePath,
        schemaPath: "#/required",
        keyword: "required",
        params: { missingProperty: "drain" },
        message: "must have required property 'drain'",
      };
      if (vErrors === null) {
        vErrors = [err6];
      } else {
        vErrors.push(err6);
      }
      errors++;
    }
    if (data.purgeRx === void 0 || !func0.call(data, "purgeRx")) {
      const err7 = {
        instancePath,
        schemaPath: "#/required",
        keyword: "required",
        params: { missingProperty: "purgeRx" },
        message: "must have required property 'purgeRx'",
      };
      if (vErrors === null) {
        vErrors = [err7];
      } else {
        vErrors.push(err7);
      }
      errors++;
    }
    if (data.purgeTx === void 0 || !func0.call(data, "purgeTx")) {
      const err8 = {
        instancePath,
        schemaPath: "#/required",
        keyword: "required",
        params: { missingProperty: "purgeTx" },
        message: "must have required property 'purgeTx'",
      };
      if (vErrors === null) {
        vErrors = [err8];
      } else {
        vErrors.push(err8);
      }
      errors++;
    }
    for (const key0 of Object.keys(data)) {
      if (!func0.call(schema50.properties, key0)) {
        const err9 = {
          instancePath,
          schemaPath: "#/additionalProperties",
          keyword: "additionalProperties",
          params: { additionalProperty: key0 },
          message: "must NOT have additional properties",
        };
        if (vErrors === null) {
          vErrors = [err9];
        } else {
          vErrors.push(err9);
        }
        errors++;
      }
    }
    if (data.configuration !== void 0 && func0.call(data, "configuration")) {
      if (typeof data.configuration !== "boolean") {
        const err10 = {
          instancePath: instancePath + "/configuration",
          schemaPath: "#/properties/configuration/type",
          keyword: "type",
          params: { type: "boolean" },
          message: "must be boolean",
        };
        if (vErrors === null) {
          vErrors = [err10];
        } else {
          vErrors.push(err10);
        }
        errors++;
      }
    }
    if (data.drain !== void 0 && func0.call(data, "drain")) {
      if (typeof data.drain !== "boolean") {
        const err11 = {
          instancePath: instancePath + "/drain",
          schemaPath: "#/properties/drain/type",
          keyword: "type",
          params: { type: "boolean" },
          message: "must be boolean",
        };
        if (vErrors === null) {
          vErrors = [err11];
        } else {
          vErrors.push(err11);
        }
        errors++;
      }
    }
    if (data.dtr !== void 0 && func0.call(data, "dtr")) {
      if (typeof data.dtr !== "boolean") {
        const err12 = {
          instancePath: instancePath + "/dtr",
          schemaPath: "#/properties/dtr/type",
          keyword: "type",
          params: { type: "boolean" },
          message: "must be boolean",
        };
        if (vErrors === null) {
          vErrors = [err12];
        } else {
          vErrors.push(err12);
        }
        errors++;
      }
    }
    if (data.finiteBreak !== void 0 && func0.call(data, "finiteBreak")) {
      if (typeof data.finiteBreak !== "boolean") {
        const err13 = {
          instancePath: instancePath + "/finiteBreak",
          schemaPath: "#/properties/finiteBreak/type",
          keyword: "type",
          params: { type: "boolean" },
          message: "must be boolean",
        };
        if (vErrors === null) {
          vErrors = [err13];
        } else {
          vErrors.push(err13);
        }
        errors++;
      }
    }
    if (data.purgeRx !== void 0 && func0.call(data, "purgeRx")) {
      if (typeof data.purgeRx !== "boolean") {
        const err14 = {
          instancePath: instancePath + "/purgeRx",
          schemaPath: "#/properties/purgeRx/type",
          keyword: "type",
          params: { type: "boolean" },
          message: "must be boolean",
        };
        if (vErrors === null) {
          vErrors = [err14];
        } else {
          vErrors.push(err14);
        }
        errors++;
      }
    }
    if (data.purgeTx !== void 0 && func0.call(data, "purgeTx")) {
      if (typeof data.purgeTx !== "boolean") {
        const err15 = {
          instancePath: instancePath + "/purgeTx",
          schemaPath: "#/properties/purgeTx/type",
          keyword: "type",
          params: { type: "boolean" },
          message: "must be boolean",
        };
        if (vErrors === null) {
          vErrors = [err15];
        } else {
          vErrors.push(err15);
        }
        errors++;
      }
    }
    if (data.queueStatus !== void 0 && func0.call(data, "queueStatus")) {
      if (typeof data.queueStatus !== "boolean") {
        const err16 = {
          instancePath: instancePath + "/queueStatus",
          schemaPath: "#/properties/queueStatus/type",
          keyword: "type",
          params: { type: "boolean" },
          message: "must be boolean",
        };
        if (vErrors === null) {
          vErrors = [err16];
        } else {
          vErrors.push(err16);
        }
        errors++;
      }
    }
    if (data.rts !== void 0 && func0.call(data, "rts")) {
      if (typeof data.rts !== "boolean") {
        const err17 = {
          instancePath: instancePath + "/rts",
          schemaPath: "#/properties/rts/type",
          keyword: "type",
          params: { type: "boolean" },
          message: "must be boolean",
        };
        if (vErrors === null) {
          vErrors = [err17];
        } else {
          vErrors.push(err17);
        }
        errors++;
      }
    }
    if (data.semantics !== void 0 && func0.call(data, "semantics")) {
      if (
        !validate176(data.semantics, {
          instancePath: instancePath + "/semantics",
          parentData: data,
          parentDataProperty: "semantics",
          rootData,
        })
      ) {
        vErrors =
          vErrors === null
            ? validate176.errors
            : vErrors.concat(validate176.errors);
        errors = vErrors.length;
      }
    }
  } else {
    const err18 = {
      instancePath,
      schemaPath: "#/type",
      keyword: "type",
      params: { type: "object" },
      message: "must be object",
    };
    if (vErrors === null) {
      vErrors = [err18];
    } else {
      vErrors.push(err18);
    }
    errors++;
  }
  validate175.errors = vErrors;
  return errors === 0;
}
var pattern8 = new RegExp("^(?:0|0)$", "u");
function validate180(
  data,
  { instancePath = "", parentData, parentDataProperty, rootData = data } = {},
) {
  let vErrors = null;
  let errors = 0;
  const _errs1 = errors;
  const _errs2 = errors;
  if (typeof data === "string") {
    if (!pattern8.test(data)) {
      const err0 = {};
      if (vErrors === null) {
        vErrors = [err0];
      } else {
        vErrors.push(err0);
      }
      errors++;
    }
  }
  var valid0 = _errs2 === errors;
  if (valid0) {
    const err1 = {
      instancePath,
      schemaPath: "#/not",
      keyword: "not",
      params: {},
      message: "must NOT be valid",
    };
    if (vErrors === null) {
      vErrors = [err1];
    } else {
      vErrors.push(err1);
    }
    errors++;
  } else {
    errors = _errs1;
    if (vErrors !== null) {
      if (_errs1) {
        vErrors.length = _errs1;
      } else {
        vErrors = null;
      }
    }
  }
  if (typeof data === "string") {
    if (!pattern0.test(data)) {
      const err2 = {
        instancePath,
        schemaPath: "#/pattern",
        keyword: "pattern",
        params: {
          pattern:
            "^(?:18446744073709551615|1[0-7][0-9]{18}|18[0-3][0-9]{17}|184[0-3][0-9]{16}|1844[0-5][0-9]{15}|18446[0-6][0-9]{14}|184467[0-3][0-9]{13}|1844674[0-3][0-9]{12}|184467440[0-6][0-9]{10}|1844674407[0-2][0-9]{9}|18446744073[0-6][0-9]{8}|1844674407370[0-8][0-9]{6}|18446744073709[0-4][0-9]{5}|184467440737095[0-4][0-9]{4}|1844674407370955[0-0][0-9]{3}|18446744073709551[0-5][0-9]{2}|184467440737095516[0-0][0-9]{1}|1844674407370955161[0-4][0-9]{0}|[1-9][0-9]{0,18}|0)$",
        },
        message:
          'must match pattern "^(?:18446744073709551615|1[0-7][0-9]{18}|18[0-3][0-9]{17}|184[0-3][0-9]{16}|1844[0-5][0-9]{15}|18446[0-6][0-9]{14}|184467[0-3][0-9]{13}|1844674[0-3][0-9]{12}|184467440[0-6][0-9]{10}|1844674407[0-2][0-9]{9}|18446744073[0-6][0-9]{8}|1844674407370[0-8][0-9]{6}|18446744073709[0-4][0-9]{5}|184467440737095[0-4][0-9]{4}|1844674407370955[0-0][0-9]{3}|18446744073709551[0-5][0-9]{2}|184467440737095516[0-0][0-9]{1}|1844674407370955161[0-4][0-9]{0}|[1-9][0-9]{0,18}|0)$"',
      };
      if (vErrors === null) {
        vErrors = [err2];
      } else {
        vErrors.push(err2);
      }
      errors++;
    }
  } else {
    const err3 = {
      instancePath,
      schemaPath: "#/type",
      keyword: "type",
      params: { type: "string" },
      message: "must be string",
    };
    if (vErrors === null) {
      vErrors = [err3];
    } else {
      vErrors.push(err3);
    }
    errors++;
  }
  validate180.errors = vErrors;
  return errors === 0;
}
var schema54 = { enum: ["5", "6", "7", "8"], type: "string" };
function validate182(
  data,
  { instancePath = "", parentData, parentDataProperty, rootData = data } = {},
) {
  let vErrors = null;
  let errors = 0;
  if (typeof data !== "string") {
    const err0 = {
      instancePath,
      schemaPath: "#/type",
      keyword: "type",
      params: { type: "string" },
      message: "must be string",
    };
    if (vErrors === null) {
      vErrors = [err0];
    } else {
      vErrors.push(err0);
    }
    errors++;
  }
  if (!(data === "5" || data === "6" || data === "7" || data === "8")) {
    const err1 = {
      instancePath,
      schemaPath: "#/enum",
      keyword: "enum",
      params: { allowedValues: schema54.enum },
      message: "must be equal to one of the allowed values",
    };
    if (vErrors === null) {
      vErrors = [err1];
    } else {
      vErrors.push(err1);
    }
    errors++;
  }
  validate182.errors = vErrors;
  return errors === 0;
}
var schema55 = {
  enum: ["none", "rtsCts", "xonXoff", "dsrDtr"],
  type: "string",
};
function validate184(
  data,
  { instancePath = "", parentData, parentDataProperty, rootData = data } = {},
) {
  let vErrors = null;
  let errors = 0;
  if (typeof data !== "string") {
    const err0 = {
      instancePath,
      schemaPath: "#/type",
      keyword: "type",
      params: { type: "string" },
      message: "must be string",
    };
    if (vErrors === null) {
      vErrors = [err0];
    } else {
      vErrors.push(err0);
    }
    errors++;
  }
  if (!(
    data === "none" ||
    data === "rtsCts" ||
    data === "xonXoff" ||
    data === "dsrDtr"
  )) {
    const err1 = {
      instancePath,
      schemaPath: "#/enum",
      keyword: "enum",
      params: { allowedValues: schema55.enum },
      message: "must be equal to one of the allowed values",
    };
    if (vErrors === null) {
      vErrors = [err1];
    } else {
      vErrors.push(err1);
    }
    errors++;
  }
  validate184.errors = vErrors;
  return errors === 0;
}
var schema56 = {
  enum: ["none", "even", "odd", "mark", "space"],
  type: "string",
};
function validate186(
  data,
  { instancePath = "", parentData, parentDataProperty, rootData = data } = {},
) {
  let vErrors = null;
  let errors = 0;
  if (typeof data !== "string") {
    const err0 = {
      instancePath,
      schemaPath: "#/type",
      keyword: "type",
      params: { type: "string" },
      message: "must be string",
    };
    if (vErrors === null) {
      vErrors = [err0];
    } else {
      vErrors.push(err0);
    }
    errors++;
  }
  if (!(
    data === "none" ||
    data === "even" ||
    data === "odd" ||
    data === "mark" ||
    data === "space"
  )) {
    const err1 = {
      instancePath,
      schemaPath: "#/enum",
      keyword: "enum",
      params: { allowedValues: schema56.enum },
      message: "must be equal to one of the allowed values",
    };
    if (vErrors === null) {
      vErrors = [err1];
    } else {
      vErrors.push(err1);
    }
    errors++;
  }
  validate186.errors = vErrors;
  return errors === 0;
}
var pattern11 = new RegExp(
  "^(?:2147483647|[1-1][0-9]{9}|2[0-0][0-9]{8}|21[0-3][0-9]{7}|214[0-6][0-9]{6}|2147[0-3][0-9]{5}|21474[0-7][0-9]{4}|214748[0-2][0-9]{3}|2147483[0-5][0-9]{2}|21474836[0-3][0-9]{1}|214748364[0-6][0-9]{0}|[1-9][0-9]{0,8}|0)$",
  "u",
);
function validate188(
  data,
  { instancePath = "", parentData, parentDataProperty, rootData = data } = {},
) {
  let vErrors = null;
  let errors = 0;
  const _errs1 = errors;
  const _errs2 = errors;
  if (typeof data === "string") {
    if (!pattern8.test(data)) {
      const err0 = {};
      if (vErrors === null) {
        vErrors = [err0];
      } else {
        vErrors.push(err0);
      }
      errors++;
    }
  }
  var valid0 = _errs2 === errors;
  if (valid0) {
    const err1 = {
      instancePath,
      schemaPath: "#/not",
      keyword: "not",
      params: {},
      message: "must NOT be valid",
    };
    if (vErrors === null) {
      vErrors = [err1];
    } else {
      vErrors.push(err1);
    }
    errors++;
  } else {
    errors = _errs1;
    if (vErrors !== null) {
      if (_errs1) {
        vErrors.length = _errs1;
      } else {
        vErrors = null;
      }
    }
  }
  if (typeof data === "string") {
    if (!pattern11.test(data)) {
      const err2 = {
        instancePath,
        schemaPath: "#/pattern",
        keyword: "pattern",
        params: {
          pattern:
            "^(?:2147483647|[1-1][0-9]{9}|2[0-0][0-9]{8}|21[0-3][0-9]{7}|214[0-6][0-9]{6}|2147[0-3][0-9]{5}|21474[0-7][0-9]{4}|214748[0-2][0-9]{3}|2147483[0-5][0-9]{2}|21474836[0-3][0-9]{1}|214748364[0-6][0-9]{0}|[1-9][0-9]{0,8}|0)$",
        },
        message:
          'must match pattern "^(?:2147483647|[1-1][0-9]{9}|2[0-0][0-9]{8}|21[0-3][0-9]{7}|214[0-6][0-9]{6}|2147[0-3][0-9]{5}|21474[0-7][0-9]{4}|214748[0-2][0-9]{3}|2147483[0-5][0-9]{2}|21474836[0-3][0-9]{1}|214748364[0-6][0-9]{0}|[1-9][0-9]{0,8}|0)$"',
      };
      if (vErrors === null) {
        vErrors = [err2];
      } else {
        vErrors.push(err2);
      }
      errors++;
    }
  } else {
    const err3 = {
      instancePath,
      schemaPath: "#/type",
      keyword: "type",
      params: { type: "string" },
      message: "must be string",
    };
    if (vErrors === null) {
      vErrors = [err3];
    } else {
      vErrors.push(err3);
    }
    errors++;
  }
  validate188.errors = vErrors;
  return errors === 0;
}
var schema58 = { enum: ["one", "onePointFive", "two"], type: "string" };
function validate191(
  data,
  { instancePath = "", parentData, parentDataProperty, rootData = data } = {},
) {
  let vErrors = null;
  let errors = 0;
  if (typeof data !== "string") {
    const err0 = {
      instancePath,
      schemaPath: "#/type",
      keyword: "type",
      params: { type: "string" },
      message: "must be string",
    };
    if (vErrors === null) {
      vErrors = [err0];
    } else {
      vErrors.push(err0);
    }
    errors++;
  }
  if (!(data === "one" || data === "onePointFive" || data === "two")) {
    const err1 = {
      instancePath,
      schemaPath: "#/enum",
      keyword: "enum",
      params: { allowedValues: schema58.enum },
      message: "must be equal to one of the allowed values",
    };
    if (vErrors === null) {
      vErrors = [err1];
    } else {
      vErrors.push(err1);
    }
    errors++;
  }
  validate191.errors = vErrors;
  return errors === 0;
}
function validate179(
  data,
  { instancePath = "", parentData, parentDataProperty, rootData = data } = {},
) {
  let vErrors = null;
  let errors = 0;
  if (data && typeof data == "object" && !Array.isArray(data)) {
    if (data.baudRate === void 0 || !func0.call(data, "baudRate")) {
      const err0 = {
        instancePath,
        schemaPath: "#/required",
        keyword: "required",
        params: { missingProperty: "baudRate" },
        message: "must have required property 'baudRate'",
      };
      if (vErrors === null) {
        vErrors = [err0];
      } else {
        vErrors.push(err0);
      }
      errors++;
    }
    if (data.dataBits === void 0 || !func0.call(data, "dataBits")) {
      const err1 = {
        instancePath,
        schemaPath: "#/required",
        keyword: "required",
        params: { missingProperty: "dataBits" },
        message: "must have required property 'dataBits'",
      };
      if (vErrors === null) {
        vErrors = [err1];
      } else {
        vErrors.push(err1);
      }
      errors++;
    }
    if (data.parity === void 0 || !func0.call(data, "parity")) {
      const err2 = {
        instancePath,
        schemaPath: "#/required",
        keyword: "required",
        params: { missingProperty: "parity" },
        message: "must have required property 'parity'",
      };
      if (vErrors === null) {
        vErrors = [err2];
      } else {
        vErrors.push(err2);
      }
      errors++;
    }
    if (data.stopBits === void 0 || !func0.call(data, "stopBits")) {
      const err3 = {
        instancePath,
        schemaPath: "#/required",
        keyword: "required",
        params: { missingProperty: "stopBits" },
        message: "must have required property 'stopBits'",
      };
      if (vErrors === null) {
        vErrors = [err3];
      } else {
        vErrors.push(err3);
      }
      errors++;
    }
    if (data.flowControl === void 0 || !func0.call(data, "flowControl")) {
      const err4 = {
        instancePath,
        schemaPath: "#/required",
        keyword: "required",
        params: { missingProperty: "flowControl" },
        message: "must have required property 'flowControl'",
      };
      if (vErrors === null) {
        vErrors = [err4];
      } else {
        vErrors.push(err4);
      }
      errors++;
    }
    if (data.readWaitMs === void 0 || !func0.call(data, "readWaitMs")) {
      const err5 = {
        instancePath,
        schemaPath: "#/required",
        keyword: "required",
        params: { missingProperty: "readWaitMs" },
        message: "must have required property 'readWaitMs'",
      };
      if (vErrors === null) {
        vErrors = [err5];
      } else {
        vErrors.push(err5);
      }
      errors++;
    }
    if (data.writeWaitMs === void 0 || !func0.call(data, "writeWaitMs")) {
      const err6 = {
        instancePath,
        schemaPath: "#/required",
        keyword: "required",
        params: { missingProperty: "writeWaitMs" },
        message: "must have required property 'writeWaitMs'",
      };
      if (vErrors === null) {
        vErrors = [err6];
      } else {
        vErrors.push(err6);
      }
      errors++;
    }
    if (
      data.reconnectBackoffMs === void 0 ||
      !func0.call(data, "reconnectBackoffMs")
    ) {
      const err7 = {
        instancePath,
        schemaPath: "#/required",
        keyword: "required",
        params: { missingProperty: "reconnectBackoffMs" },
        message: "must have required property 'reconnectBackoffMs'",
      };
      if (vErrors === null) {
        vErrors = [err7];
      } else {
        vErrors.push(err7);
      }
      errors++;
    }
    for (const key0 of Object.keys(data)) {
      if (!(
        key0 === "baudRate" ||
        key0 === "dataBits" ||
        key0 === "flowControl" ||
        key0 === "parity" ||
        key0 === "readWaitMs" ||
        key0 === "reconnectBackoffMs" ||
        key0 === "stopBits" ||
        key0 === "writeWaitMs"
      )) {
        const err8 = {
          instancePath,
          schemaPath: "#/additionalProperties",
          keyword: "additionalProperties",
          params: { additionalProperty: key0 },
          message: "must NOT have additional properties",
        };
        if (vErrors === null) {
          vErrors = [err8];
        } else {
          vErrors.push(err8);
        }
        errors++;
      }
    }
    if (data.baudRate !== void 0 && func0.call(data, "baudRate")) {
      if (
        !validate180(data.baudRate, {
          instancePath: instancePath + "/baudRate",
          parentData: data,
          parentDataProperty: "baudRate",
          rootData,
        })
      ) {
        vErrors =
          vErrors === null
            ? validate180.errors
            : vErrors.concat(validate180.errors);
        errors = vErrors.length;
      }
    }
    if (data.dataBits !== void 0 && func0.call(data, "dataBits")) {
      if (
        !validate182(data.dataBits, {
          instancePath: instancePath + "/dataBits",
          parentData: data,
          parentDataProperty: "dataBits",
          rootData,
        })
      ) {
        vErrors =
          vErrors === null
            ? validate182.errors
            : vErrors.concat(validate182.errors);
        errors = vErrors.length;
      }
    }
    if (data.flowControl !== void 0 && func0.call(data, "flowControl")) {
      if (
        !validate184(data.flowControl, {
          instancePath: instancePath + "/flowControl",
          parentData: data,
          parentDataProperty: "flowControl",
          rootData,
        })
      ) {
        vErrors =
          vErrors === null
            ? validate184.errors
            : vErrors.concat(validate184.errors);
        errors = vErrors.length;
      }
    }
    if (data.parity !== void 0 && func0.call(data, "parity")) {
      if (
        !validate186(data.parity, {
          instancePath: instancePath + "/parity",
          parentData: data,
          parentDataProperty: "parity",
          rootData,
        })
      ) {
        vErrors =
          vErrors === null
            ? validate186.errors
            : vErrors.concat(validate186.errors);
        errors = vErrors.length;
      }
    }
    if (data.readWaitMs !== void 0 && func0.call(data, "readWaitMs")) {
      if (
        !validate188(data.readWaitMs, {
          instancePath: instancePath + "/readWaitMs",
          parentData: data,
          parentDataProperty: "readWaitMs",
          rootData,
        })
      ) {
        vErrors =
          vErrors === null
            ? validate188.errors
            : vErrors.concat(validate188.errors);
        errors = vErrors.length;
      }
    }
    if (
      data.reconnectBackoffMs !== void 0 &&
      func0.call(data, "reconnectBackoffMs")
    ) {
      if (
        !validate188(data.reconnectBackoffMs, {
          instancePath: instancePath + "/reconnectBackoffMs",
          parentData: data,
          parentDataProperty: "reconnectBackoffMs",
          rootData,
        })
      ) {
        vErrors =
          vErrors === null
            ? validate188.errors
            : vErrors.concat(validate188.errors);
        errors = vErrors.length;
      }
    }
    if (data.stopBits !== void 0 && func0.call(data, "stopBits")) {
      if (
        !validate191(data.stopBits, {
          instancePath: instancePath + "/stopBits",
          parentData: data,
          parentDataProperty: "stopBits",
          rootData,
        })
      ) {
        vErrors =
          vErrors === null
            ? validate191.errors
            : vErrors.concat(validate191.errors);
        errors = vErrors.length;
      }
    }
    if (data.writeWaitMs !== void 0 && func0.call(data, "writeWaitMs")) {
      if (
        !validate188(data.writeWaitMs, {
          instancePath: instancePath + "/writeWaitMs",
          parentData: data,
          parentDataProperty: "writeWaitMs",
          rootData,
        })
      ) {
        vErrors =
          vErrors === null
            ? validate188.errors
            : vErrors.concat(validate188.errors);
        errors = vErrors.length;
      }
    }
  } else {
    const err9 = {
      instancePath,
      schemaPath: "#/type",
      keyword: "type",
      params: { type: "object" },
      message: "must be object",
    };
    if (vErrors === null) {
      vErrors = [err9];
    } else {
      vErrors.push(err9);
    }
    errors++;
  }
  validate179.errors = vErrors;
  return errors === 0;
}
var schema59 = {
  enum: ["clear", "asserting", "asserted", "clearing", "unknown"],
  type: "string",
};
function validate196(
  data,
  { instancePath = "", parentData, parentDataProperty, rootData = data } = {},
) {
  let vErrors = null;
  let errors = 0;
  if (typeof data !== "string") {
    const err0 = {
      instancePath,
      schemaPath: "#/type",
      keyword: "type",
      params: { type: "string" },
      message: "must be string",
    };
    if (vErrors === null) {
      vErrors = [err0];
    } else {
      vErrors.push(err0);
    }
    errors++;
  }
  if (!(
    data === "clear" ||
    data === "asserting" ||
    data === "asserted" ||
    data === "clearing" ||
    data === "unknown"
  )) {
    const err1 = {
      instancePath,
      schemaPath: "#/enum",
      keyword: "enum",
      params: { allowedValues: schema59.enum },
      message: "must be equal to one of the allowed values",
    };
    if (vErrors === null) {
      vErrors = [err1];
    } else {
      vErrors.push(err1);
    }
    errors++;
  }
  validate196.errors = vErrors;
  return errors === 0;
}
var schema60 = {
  additionalProperties: false,
  properties: {
    actorId: { $ref: "#/definitions/shared/definitions/Id" },
    executionMode: { $ref: "#/definitions/shared/definitions/ExecutionMode" },
    expiresAtMonoNs: { $ref: "#/definitions/shared/definitions/U64" },
    kind: { $ref: "#/definitions/shared/definitions/LeaseKind" },
    leaseId: { $ref: "#/definitions/shared/definitions/Id" },
    ownerOperationId: { $ref: "#/definitions/shared/definitions/Id" },
    sessionEpoch: { $ref: "#/definitions/shared/definitions/U64" },
    sessionId: { $ref: "#/definitions/shared/definitions/Id" },
    state: { $ref: "#/definitions/shared/definitions/LeaseState" },
  },
  required: [
    "leaseId",
    "sessionId",
    "sessionEpoch",
    "actorId",
    "ownerOperationId",
    "kind",
    "state",
    "executionMode",
    "expiresAtMonoNs",
  ],
  type: "object",
};
var schema61 = { enum: ["interactive", "independent"], type: "string" };
function validate201(
  data,
  { instancePath = "", parentData, parentDataProperty, rootData = data } = {},
) {
  let vErrors = null;
  let errors = 0;
  if (typeof data !== "string") {
    const err0 = {
      instancePath,
      schemaPath: "#/type",
      keyword: "type",
      params: { type: "string" },
      message: "must be string",
    };
    if (vErrors === null) {
      vErrors = [err0];
    } else {
      vErrors.push(err0);
    }
    errors++;
  }
  if (!(data === "interactive" || data === "independent")) {
    const err1 = {
      instancePath,
      schemaPath: "#/enum",
      keyword: "enum",
      params: { allowedValues: schema61.enum },
      message: "must be equal to one of the allowed values",
    };
    if (vErrors === null) {
      vErrors = [err1];
    } else {
      vErrors.push(err1);
    }
    errors++;
  }
  validate201.errors = vErrors;
  return errors === 0;
}
var schema62 = {
  enum: ["ordinary", "transaction", "exclusive"],
  type: "string",
};
function validate204(
  data,
  { instancePath = "", parentData, parentDataProperty, rootData = data } = {},
) {
  let vErrors = null;
  let errors = 0;
  if (typeof data !== "string") {
    const err0 = {
      instancePath,
      schemaPath: "#/type",
      keyword: "type",
      params: { type: "string" },
      message: "must be string",
    };
    if (vErrors === null) {
      vErrors = [err0];
    } else {
      vErrors.push(err0);
    }
    errors++;
  }
  if (!(
    data === "ordinary" ||
    data === "transaction" ||
    data === "exclusive"
  )) {
    const err1 = {
      instancePath,
      schemaPath: "#/enum",
      keyword: "enum",
      params: { allowedValues: schema62.enum },
      message: "must be equal to one of the allowed values",
    };
    if (vErrors === null) {
      vErrors = [err1];
    } else {
      vErrors.push(err1);
    }
    errors++;
  }
  validate204.errors = vErrors;
  return errors === 0;
}
var schema63 = {
  enum: ["active", "revoking", "released", "expired"],
  type: "string",
};
function validate210(
  data,
  { instancePath = "", parentData, parentDataProperty, rootData = data } = {},
) {
  let vErrors = null;
  let errors = 0;
  if (typeof data !== "string") {
    const err0 = {
      instancePath,
      schemaPath: "#/type",
      keyword: "type",
      params: { type: "string" },
      message: "must be string",
    };
    if (vErrors === null) {
      vErrors = [err0];
    } else {
      vErrors.push(err0);
    }
    errors++;
  }
  if (!(
    data === "active" ||
    data === "revoking" ||
    data === "released" ||
    data === "expired"
  )) {
    const err1 = {
      instancePath,
      schemaPath: "#/enum",
      keyword: "enum",
      params: { allowedValues: schema63.enum },
      message: "must be equal to one of the allowed values",
    };
    if (vErrors === null) {
      vErrors = [err1];
    } else {
      vErrors.push(err1);
    }
    errors++;
  }
  validate210.errors = vErrors;
  return errors === 0;
}
function validate199(
  data,
  { instancePath = "", parentData, parentDataProperty, rootData = data } = {},
) {
  let vErrors = null;
  let errors = 0;
  if (data && typeof data == "object" && !Array.isArray(data)) {
    if (data.leaseId === void 0 || !func0.call(data, "leaseId")) {
      const err0 = {
        instancePath,
        schemaPath: "#/required",
        keyword: "required",
        params: { missingProperty: "leaseId" },
        message: "must have required property 'leaseId'",
      };
      if (vErrors === null) {
        vErrors = [err0];
      } else {
        vErrors.push(err0);
      }
      errors++;
    }
    if (data.sessionId === void 0 || !func0.call(data, "sessionId")) {
      const err1 = {
        instancePath,
        schemaPath: "#/required",
        keyword: "required",
        params: { missingProperty: "sessionId" },
        message: "must have required property 'sessionId'",
      };
      if (vErrors === null) {
        vErrors = [err1];
      } else {
        vErrors.push(err1);
      }
      errors++;
    }
    if (data.sessionEpoch === void 0 || !func0.call(data, "sessionEpoch")) {
      const err2 = {
        instancePath,
        schemaPath: "#/required",
        keyword: "required",
        params: { missingProperty: "sessionEpoch" },
        message: "must have required property 'sessionEpoch'",
      };
      if (vErrors === null) {
        vErrors = [err2];
      } else {
        vErrors.push(err2);
      }
      errors++;
    }
    if (data.actorId === void 0 || !func0.call(data, "actorId")) {
      const err3 = {
        instancePath,
        schemaPath: "#/required",
        keyword: "required",
        params: { missingProperty: "actorId" },
        message: "must have required property 'actorId'",
      };
      if (vErrors === null) {
        vErrors = [err3];
      } else {
        vErrors.push(err3);
      }
      errors++;
    }
    if (
      data.ownerOperationId === void 0 ||
      !func0.call(data, "ownerOperationId")
    ) {
      const err4 = {
        instancePath,
        schemaPath: "#/required",
        keyword: "required",
        params: { missingProperty: "ownerOperationId" },
        message: "must have required property 'ownerOperationId'",
      };
      if (vErrors === null) {
        vErrors = [err4];
      } else {
        vErrors.push(err4);
      }
      errors++;
    }
    if (data.kind === void 0 || !func0.call(data, "kind")) {
      const err5 = {
        instancePath,
        schemaPath: "#/required",
        keyword: "required",
        params: { missingProperty: "kind" },
        message: "must have required property 'kind'",
      };
      if (vErrors === null) {
        vErrors = [err5];
      } else {
        vErrors.push(err5);
      }
      errors++;
    }
    if (data.state === void 0 || !func0.call(data, "state")) {
      const err6 = {
        instancePath,
        schemaPath: "#/required",
        keyword: "required",
        params: { missingProperty: "state" },
        message: "must have required property 'state'",
      };
      if (vErrors === null) {
        vErrors = [err6];
      } else {
        vErrors.push(err6);
      }
      errors++;
    }
    if (data.executionMode === void 0 || !func0.call(data, "executionMode")) {
      const err7 = {
        instancePath,
        schemaPath: "#/required",
        keyword: "required",
        params: { missingProperty: "executionMode" },
        message: "must have required property 'executionMode'",
      };
      if (vErrors === null) {
        vErrors = [err7];
      } else {
        vErrors.push(err7);
      }
      errors++;
    }
    if (
      data.expiresAtMonoNs === void 0 ||
      !func0.call(data, "expiresAtMonoNs")
    ) {
      const err8 = {
        instancePath,
        schemaPath: "#/required",
        keyword: "required",
        params: { missingProperty: "expiresAtMonoNs" },
        message: "must have required property 'expiresAtMonoNs'",
      };
      if (vErrors === null) {
        vErrors = [err8];
      } else {
        vErrors.push(err8);
      }
      errors++;
    }
    for (const key0 of Object.keys(data)) {
      if (!func0.call(schema60.properties, key0)) {
        const err9 = {
          instancePath,
          schemaPath: "#/additionalProperties",
          keyword: "additionalProperties",
          params: { additionalProperty: key0 },
          message: "must NOT have additional properties",
        };
        if (vErrors === null) {
          vErrors = [err9];
        } else {
          vErrors.push(err9);
        }
        errors++;
      }
    }
    if (data.actorId !== void 0 && func0.call(data, "actorId")) {
      if (
        !validate26(data.actorId, {
          instancePath: instancePath + "/actorId",
          parentData: data,
          parentDataProperty: "actorId",
          rootData,
        })
      ) {
        vErrors =
          vErrors === null
            ? validate26.errors
            : vErrors.concat(validate26.errors);
        errors = vErrors.length;
      }
    }
    if (data.executionMode !== void 0 && func0.call(data, "executionMode")) {
      if (
        !validate201(data.executionMode, {
          instancePath: instancePath + "/executionMode",
          parentData: data,
          parentDataProperty: "executionMode",
          rootData,
        })
      ) {
        vErrors =
          vErrors === null
            ? validate201.errors
            : vErrors.concat(validate201.errors);
        errors = vErrors.length;
      }
    }
    if (
      data.expiresAtMonoNs !== void 0 &&
      func0.call(data, "expiresAtMonoNs")
    ) {
      if (
        !validate23(data.expiresAtMonoNs, {
          instancePath: instancePath + "/expiresAtMonoNs",
          parentData: data,
          parentDataProperty: "expiresAtMonoNs",
          rootData,
        })
      ) {
        vErrors =
          vErrors === null
            ? validate23.errors
            : vErrors.concat(validate23.errors);
        errors = vErrors.length;
      }
    }
    if (data.kind !== void 0 && func0.call(data, "kind")) {
      if (
        !validate204(data.kind, {
          instancePath: instancePath + "/kind",
          parentData: data,
          parentDataProperty: "kind",
          rootData,
        })
      ) {
        vErrors =
          vErrors === null
            ? validate204.errors
            : vErrors.concat(validate204.errors);
        errors = vErrors.length;
      }
    }
    if (data.leaseId !== void 0 && func0.call(data, "leaseId")) {
      if (
        !validate26(data.leaseId, {
          instancePath: instancePath + "/leaseId",
          parentData: data,
          parentDataProperty: "leaseId",
          rootData,
        })
      ) {
        vErrors =
          vErrors === null
            ? validate26.errors
            : vErrors.concat(validate26.errors);
        errors = vErrors.length;
      }
    }
    if (
      data.ownerOperationId !== void 0 &&
      func0.call(data, "ownerOperationId")
    ) {
      if (
        !validate26(data.ownerOperationId, {
          instancePath: instancePath + "/ownerOperationId",
          parentData: data,
          parentDataProperty: "ownerOperationId",
          rootData,
        })
      ) {
        vErrors =
          vErrors === null
            ? validate26.errors
            : vErrors.concat(validate26.errors);
        errors = vErrors.length;
      }
    }
    if (data.sessionEpoch !== void 0 && func0.call(data, "sessionEpoch")) {
      if (
        !validate23(data.sessionEpoch, {
          instancePath: instancePath + "/sessionEpoch",
          parentData: data,
          parentDataProperty: "sessionEpoch",
          rootData,
        })
      ) {
        vErrors =
          vErrors === null
            ? validate23.errors
            : vErrors.concat(validate23.errors);
        errors = vErrors.length;
      }
    }
    if (data.sessionId !== void 0 && func0.call(data, "sessionId")) {
      if (
        !validate26(data.sessionId, {
          instancePath: instancePath + "/sessionId",
          parentData: data,
          parentDataProperty: "sessionId",
          rootData,
        })
      ) {
        vErrors =
          vErrors === null
            ? validate26.errors
            : vErrors.concat(validate26.errors);
        errors = vErrors.length;
      }
    }
    if (data.state !== void 0 && func0.call(data, "state")) {
      if (
        !validate210(data.state, {
          instancePath: instancePath + "/state",
          parentData: data,
          parentDataProperty: "state",
          rootData,
        })
      ) {
        vErrors =
          vErrors === null
            ? validate210.errors
            : vErrors.concat(validate210.errors);
        errors = vErrors.length;
      }
    }
  } else {
    const err10 = {
      instancePath,
      schemaPath: "#/type",
      keyword: "type",
      params: { type: "object" },
      message: "must be object",
    };
    if (vErrors === null) {
      vErrors = [err10];
    } else {
      vErrors.push(err10);
    }
    errors++;
  }
  validate199.errors = vErrors;
  return errors === 0;
}
var schema65 = {
  enum: ["idle", "waiting", "attempting", "requires_rebind", "stopped"],
  type: "string",
};
function validate216(
  data,
  { instancePath = "", parentData, parentDataProperty, rootData = data } = {},
) {
  let vErrors = null;
  let errors = 0;
  if (typeof data !== "string") {
    const err0 = {
      instancePath,
      schemaPath: "#/type",
      keyword: "type",
      params: { type: "string" },
      message: "must be string",
    };
    if (vErrors === null) {
      vErrors = [err0];
    } else {
      vErrors.push(err0);
    }
    errors++;
  }
  if (!(
    data === "idle" ||
    data === "waiting" ||
    data === "attempting" ||
    data === "requires_rebind" ||
    data === "stopped"
  )) {
    const err1 = {
      instancePath,
      schemaPath: "#/enum",
      keyword: "enum",
      params: { allowedValues: schema65.enum },
      message: "must be equal to one of the allowed values",
    };
    if (vErrors === null) {
      vErrors = [err1];
    } else {
      vErrors.push(err1);
    }
    errors++;
  }
  validate216.errors = vErrors;
  return errors === 0;
}
function validate213(
  data,
  { instancePath = "", parentData, parentDataProperty, rootData = data } = {},
) {
  let vErrors = null;
  let errors = 0;
  if (data && typeof data == "object" && !Array.isArray(data)) {
    if (data.state === void 0 || !func0.call(data, "state")) {
      const err0 = {
        instancePath,
        schemaPath: "#/required",
        keyword: "required",
        params: { missingProperty: "state" },
        message: "must have required property 'state'",
      };
      if (vErrors === null) {
        vErrors = [err0];
      } else {
        vErrors.push(err0);
      }
      errors++;
    }
    if (data.attempts === void 0 || !func0.call(data, "attempts")) {
      const err1 = {
        instancePath,
        schemaPath: "#/required",
        keyword: "required",
        params: { missingProperty: "attempts" },
        message: "must have required property 'attempts'",
      };
      if (vErrors === null) {
        vErrors = [err1];
      } else {
        vErrors.push(err1);
      }
      errors++;
    }
    for (const key0 of Object.keys(data)) {
      if (!(key0 === "attempts" || key0 === "lastError" || key0 === "state")) {
        const err2 = {
          instancePath,
          schemaPath: "#/additionalProperties",
          keyword: "additionalProperties",
          params: { additionalProperty: key0 },
          message: "must NOT have additional properties",
        };
        if (vErrors === null) {
          vErrors = [err2];
        } else {
          vErrors.push(err2);
        }
        errors++;
      }
    }
    if (data.attempts !== void 0 && func0.call(data, "attempts")) {
      if (
        !validate23(data.attempts, {
          instancePath: instancePath + "/attempts",
          parentData: data,
          parentDataProperty: "attempts",
          rootData,
        })
      ) {
        vErrors =
          vErrors === null
            ? validate23.errors
            : vErrors.concat(validate23.errors);
        errors = vErrors.length;
      }
    }
    if (data.lastError !== void 0 && func0.call(data, "lastError")) {
      if (
        !validate101(data.lastError, {
          instancePath: instancePath + "/lastError",
          parentData: data,
          parentDataProperty: "lastError",
          rootData,
        })
      ) {
        vErrors =
          vErrors === null
            ? validate101.errors
            : vErrors.concat(validate101.errors);
        errors = vErrors.length;
      }
    }
    if (data.state !== void 0 && func0.call(data, "state")) {
      if (
        !validate216(data.state, {
          instancePath: instancePath + "/state",
          parentData: data,
          parentDataProperty: "state",
          rootData,
        })
      ) {
        vErrors =
          vErrors === null
            ? validate216.errors
            : vErrors.concat(validate216.errors);
        errors = vErrors.length;
      }
    }
  } else {
    const err3 = {
      instancePath,
      schemaPath: "#/type",
      keyword: "type",
      params: { type: "object" },
      message: "must be object",
    };
    if (vErrors === null) {
      vErrors = [err3];
    } else {
      vErrors.push(err3);
    }
    errors++;
  }
  validate213.errors = vErrors;
  return errors === 0;
}
var schema66 = {
  enum: ["closed", "opening", "open", "disconnected", "closing"],
  type: "string",
};
function validate222(
  data,
  { instancePath = "", parentData, parentDataProperty, rootData = data } = {},
) {
  let vErrors = null;
  let errors = 0;
  if (typeof data !== "string") {
    const err0 = {
      instancePath,
      schemaPath: "#/type",
      keyword: "type",
      params: { type: "string" },
      message: "must be string",
    };
    if (vErrors === null) {
      vErrors = [err0];
    } else {
      vErrors.push(err0);
    }
    errors++;
  }
  if (!(
    data === "closed" ||
    data === "opening" ||
    data === "open" ||
    data === "disconnected" ||
    data === "closing"
  )) {
    const err1 = {
      instancePath,
      schemaPath: "#/enum",
      keyword: "enum",
      params: { allowedValues: schema66.enum },
      message: "must be equal to one of the allowed values",
    };
    if (vErrors === null) {
      vErrors = [err1];
    } else {
      vErrors.push(err1);
    }
    errors++;
  }
  validate222.errors = vErrors;
  return errors === 0;
}
var schema67 = {
  enum: [
    "ready",
    "configuration_pending",
    "control_unknown",
    "closing",
    "disconnected",
  ],
  type: "string",
};
function validate224(
  data,
  { instancePath = "", parentData, parentDataProperty, rootData = data } = {},
) {
  let vErrors = null;
  let errors = 0;
  if (typeof data !== "string") {
    const err0 = {
      instancePath,
      schemaPath: "#/type",
      keyword: "type",
      params: { type: "string" },
      message: "must be string",
    };
    if (vErrors === null) {
      vErrors = [err0];
    } else {
      vErrors.push(err0);
    }
    errors++;
  }
  if (!(
    data === "ready" ||
    data === "configuration_pending" ||
    data === "control_unknown" ||
    data === "closing" ||
    data === "disconnected"
  )) {
    const err1 = {
      instancePath,
      schemaPath: "#/enum",
      keyword: "enum",
      params: { allowedValues: schema67.enum },
      message: "must be equal to one of the allowed values",
    };
    if (vErrors === null) {
      vErrors = [err1];
    } else {
      vErrors.push(err1);
    }
    errors++;
  }
  validate224.errors = vErrors;
  return errors === 0;
}
function validate174(
  data,
  { instancePath = "", parentData, parentDataProperty, rootData = data } = {},
) {
  let vErrors = null;
  let errors = 0;
  if (data && typeof data == "object" && !Array.isArray(data)) {
    if (data.sessionId === void 0 || !func0.call(data, "sessionId")) {
      const err0 = {
        instancePath,
        schemaPath: "#/required",
        keyword: "required",
        params: { missingProperty: "sessionId" },
        message: "must have required property 'sessionId'",
      };
      if (vErrors === null) {
        vErrors = [err0];
      } else {
        vErrors.push(err0);
      }
      errors++;
    }
    if (data.deviceId === void 0 || !func0.call(data, "deviceId")) {
      const err1 = {
        instancePath,
        schemaPath: "#/required",
        keyword: "required",
        params: { missingProperty: "deviceId" },
        message: "must have required property 'deviceId'",
      };
      if (vErrors === null) {
        vErrors = [err1];
      } else {
        vErrors.push(err1);
      }
      errors++;
    }
    if (data.sessionEpoch === void 0 || !func0.call(data, "sessionEpoch")) {
      const err2 = {
        instancePath,
        schemaPath: "#/required",
        keyword: "required",
        params: { missingProperty: "sessionEpoch" },
        message: "must have required property 'sessionEpoch'",
      };
      if (vErrors === null) {
        vErrors = [err2];
      } else {
        vErrors.push(err2);
      }
      errors++;
    }
    if (data.revision === void 0 || !func0.call(data, "revision")) {
      const err3 = {
        instancePath,
        schemaPath: "#/required",
        keyword: "required",
        params: { missingProperty: "revision" },
        message: "must have required property 'revision'",
      };
      if (vErrors === null) {
        vErrors = [err3];
      } else {
        vErrors.push(err3);
      }
      errors++;
    }
    if (
      data.configurationRevision === void 0 ||
      !func0.call(data, "configurationRevision")
    ) {
      const err4 = {
        instancePath,
        schemaPath: "#/required",
        keyword: "required",
        params: { missingProperty: "configurationRevision" },
        message: "must have required property 'configurationRevision'",
      };
      if (vErrors === null) {
        vErrors = [err4];
      } else {
        vErrors.push(err4);
      }
      errors++;
    }
    if (data.state === void 0 || !func0.call(data, "state")) {
      const err5 = {
        instancePath,
        schemaPath: "#/required",
        keyword: "required",
        params: { missingProperty: "state" },
        message: "must have required property 'state'",
      };
      if (vErrors === null) {
        vErrors = [err5];
      } else {
        vErrors.push(err5);
      }
      errors++;
    }
    if (data.configuration === void 0 || !func0.call(data, "configuration")) {
      const err6 = {
        instancePath,
        schemaPath: "#/required",
        keyword: "required",
        params: { missingProperty: "configuration" },
        message: "must have required property 'configuration'",
      };
      if (vErrors === null) {
        vErrors = [err6];
      } else {
        vErrors.push(err6);
      }
      errors++;
    }
    if (data.readOnly === void 0 || !func0.call(data, "readOnly")) {
      const err7 = {
        instancePath,
        schemaPath: "#/required",
        keyword: "required",
        params: { missingProperty: "readOnly" },
        message: "must have required property 'readOnly'",
      };
      if (vErrors === null) {
        vErrors = [err7];
      } else {
        vErrors.push(err7);
      }
      errors++;
    }
    if (data.txGate === void 0 || !func0.call(data, "txGate")) {
      const err8 = {
        instancePath,
        schemaPath: "#/required",
        keyword: "required",
        params: { missingProperty: "txGate" },
        message: "must have required property 'txGate'",
      };
      if (vErrors === null) {
        vErrors = [err8];
      } else {
        vErrors.push(err8);
      }
      errors++;
    }
    if (data.controlState === void 0 || !func0.call(data, "controlState")) {
      const err9 = {
        instancePath,
        schemaPath: "#/required",
        keyword: "required",
        params: { missingProperty: "controlState" },
        message: "must have required property 'controlState'",
      };
      if (vErrors === null) {
        vErrors = [err9];
      } else {
        vErrors.push(err9);
      }
      errors++;
    }
    if (data.capabilities === void 0 || !func0.call(data, "capabilities")) {
      const err10 = {
        instancePath,
        schemaPath: "#/required",
        keyword: "required",
        params: { missingProperty: "capabilities" },
        message: "must have required property 'capabilities'",
      };
      if (vErrors === null) {
        vErrors = [err10];
      } else {
        vErrors.push(err10);
      }
      errors++;
    }
    for (const key0 of Object.keys(data)) {
      if (!func0.call(schema49.properties, key0)) {
        const err11 = {
          instancePath,
          schemaPath: "#/additionalProperties",
          keyword: "additionalProperties",
          params: { additionalProperty: key0 },
          message: "must NOT have additional properties",
        };
        if (vErrors === null) {
          vErrors = [err11];
        } else {
          vErrors.push(err11);
        }
        errors++;
      }
    }
    if (data.capabilities !== void 0 && func0.call(data, "capabilities")) {
      if (
        !validate175(data.capabilities, {
          instancePath: instancePath + "/capabilities",
          parentData: data,
          parentDataProperty: "capabilities",
          rootData,
        })
      ) {
        vErrors =
          vErrors === null
            ? validate175.errors
            : vErrors.concat(validate175.errors);
        errors = vErrors.length;
      }
    }
    if (data.configuration !== void 0 && func0.call(data, "configuration")) {
      if (
        !validate179(data.configuration, {
          instancePath: instancePath + "/configuration",
          parentData: data,
          parentDataProperty: "configuration",
          rootData,
        })
      ) {
        vErrors =
          vErrors === null
            ? validate179.errors
            : vErrors.concat(validate179.errors);
        errors = vErrors.length;
      }
    }
    if (
      data.configurationRevision !== void 0 &&
      func0.call(data, "configurationRevision")
    ) {
      if (
        !validate23(data.configurationRevision, {
          instancePath: instancePath + "/configurationRevision",
          parentData: data,
          parentDataProperty: "configurationRevision",
          rootData,
        })
      ) {
        vErrors =
          vErrors === null
            ? validate23.errors
            : vErrors.concat(validate23.errors);
        errors = vErrors.length;
      }
    }
    if (data.controlState !== void 0 && func0.call(data, "controlState")) {
      if (
        !validate196(data.controlState, {
          instancePath: instancePath + "/controlState",
          parentData: data,
          parentDataProperty: "controlState",
          rootData,
        })
      ) {
        vErrors =
          vErrors === null
            ? validate196.errors
            : vErrors.concat(validate196.errors);
        errors = vErrors.length;
      }
    }
    if (data.deviceId !== void 0 && func0.call(data, "deviceId")) {
      if (
        !validate26(data.deviceId, {
          instancePath: instancePath + "/deviceId",
          parentData: data,
          parentDataProperty: "deviceId",
          rootData,
        })
      ) {
        vErrors =
          vErrors === null
            ? validate26.errors
            : vErrors.concat(validate26.errors);
        errors = vErrors.length;
      }
    }
    if (data.lease !== void 0 && func0.call(data, "lease")) {
      if (
        !validate199(data.lease, {
          instancePath: instancePath + "/lease",
          parentData: data,
          parentDataProperty: "lease",
          rootData,
        })
      ) {
        vErrors =
          vErrors === null
            ? validate199.errors
            : vErrors.concat(validate199.errors);
        errors = vErrors.length;
      }
    }
    if (data.readOnly !== void 0 && func0.call(data, "readOnly")) {
      if (typeof data.readOnly !== "boolean") {
        const err12 = {
          instancePath: instancePath + "/readOnly",
          schemaPath: "#/properties/readOnly/type",
          keyword: "type",
          params: { type: "boolean" },
          message: "must be boolean",
        };
        if (vErrors === null) {
          vErrors = [err12];
        } else {
          vErrors.push(err12);
        }
        errors++;
      }
    }
    if (data.reconnect !== void 0 && func0.call(data, "reconnect")) {
      if (
        !validate213(data.reconnect, {
          instancePath: instancePath + "/reconnect",
          parentData: data,
          parentDataProperty: "reconnect",
          rootData,
        })
      ) {
        vErrors =
          vErrors === null
            ? validate213.errors
            : vErrors.concat(validate213.errors);
        errors = vErrors.length;
      }
    }
    if (data.revision !== void 0 && func0.call(data, "revision")) {
      if (
        !validate23(data.revision, {
          instancePath: instancePath + "/revision",
          parentData: data,
          parentDataProperty: "revision",
          rootData,
        })
      ) {
        vErrors =
          vErrors === null
            ? validate23.errors
            : vErrors.concat(validate23.errors);
        errors = vErrors.length;
      }
    }
    if (data.sessionEpoch !== void 0 && func0.call(data, "sessionEpoch")) {
      if (
        !validate23(data.sessionEpoch, {
          instancePath: instancePath + "/sessionEpoch",
          parentData: data,
          parentDataProperty: "sessionEpoch",
          rootData,
        })
      ) {
        vErrors =
          vErrors === null
            ? validate23.errors
            : vErrors.concat(validate23.errors);
        errors = vErrors.length;
      }
    }
    if (data.sessionId !== void 0 && func0.call(data, "sessionId")) {
      if (
        !validate26(data.sessionId, {
          instancePath: instancePath + "/sessionId",
          parentData: data,
          parentDataProperty: "sessionId",
          rootData,
        })
      ) {
        vErrors =
          vErrors === null
            ? validate26.errors
            : vErrors.concat(validate26.errors);
        errors = vErrors.length;
      }
    }
    if (data.state !== void 0 && func0.call(data, "state")) {
      if (
        !validate222(data.state, {
          instancePath: instancePath + "/state",
          parentData: data,
          parentDataProperty: "state",
          rootData,
        })
      ) {
        vErrors =
          vErrors === null
            ? validate222.errors
            : vErrors.concat(validate222.errors);
        errors = vErrors.length;
      }
    }
    if (data.txGate !== void 0 && func0.call(data, "txGate")) {
      if (
        !validate224(data.txGate, {
          instancePath: instancePath + "/txGate",
          parentData: data,
          parentDataProperty: "txGate",
          rootData,
        })
      ) {
        vErrors =
          vErrors === null
            ? validate224.errors
            : vErrors.concat(validate224.errors);
        errors = vErrors.length;
      }
    }
  } else {
    const err13 = {
      instancePath,
      schemaPath: "#/type",
      keyword: "type",
      params: { type: "object" },
      message: "must be object",
    };
    if (vErrors === null) {
      vErrors = [err13];
    } else {
      vErrors.push(err13);
    }
    errors++;
  }
  validate174.errors = vErrors;
  return errors === 0;
}
export {
  validateDerivedReadResult,
  validateHostError,
  validateRawBatch,
  validateRequestId,
  validateSessionSnapshot,
};
