"""Versioned technical contract. Rebuild fields; never pass through free text."""

import json
import re
from pathlib import Path

CONTRACT = json.loads(Path(__file__).with_name("diagnostic-contract.json").read_text())
TAG_NAMES = [
    "diagnostic_version", "error_type", "technical_cause", "component", "operation",
    "diagnostic_location", "correlation_id", "impact", "recovery",
    *[f"diagnostic_frame_{i}" for i in range(CONTRACT["maxFrames"])],
    *[name for i in range(CONTRACT["maxCauses"]) for name in (f"cause_type_{i}", f"cause_code_{i}")],
]
SOURCE_FILES = frozenset(CONTRACT["sourceFiles"])


def technical_cause(code):
    if code == "PRISMA_PROXY_OWN_KEYS":
        return "prisma_proxy_invariant"
    if re.match(r"^(WAHA|EVOLUTION|HISTORY)_HTTP_", code):
        return "provider_http_failure"
    if re.fullmatch(r"P\d{4}", code, re.ASCII):
        return "database_error"
    if re.match(r"^(ECONN|ETIMEDOUT|ENOTFOUND|EPIPE|INGRESS_)", code):
        return "network_error"
    return {"INVALID_UNICODE": "invalid_unicode", "AGENT_RUN_FAILED": "operation_returned_failed",
            "OUTBOUND_UNCERTAIN": "delivery_unconfirmed", "WAHA_DESTINATION_UNRESOLVED": "destination_resolution_failed",
            "EMPTY_TRANSCRIPT": "transcription_error", "TRANSCRIPTION_IN_PROGRESS": "transcription_error"}.get(code,
            "tool_error" if code.startswith("TOOL_") else "media_error" if code.startswith("MEDIA_") else "unexpected_error")


def frame(value):
    if not isinstance(value, str) or len(value) > 200:
        return None
    match = re.fullmatch(r"([^:]+):([0-9]{1,7}):([0-9]{1,7})", value, re.ASCII)
    if not match:
        return None
    filename, line, column = match.groups()
    if filename not in SOURCE_FILES and not re.fullmatch(r"dist/(?:chunk-[A-Z0-9]{8}|server|ingress|ingress-worker)\.js", filename, re.ASCII):
        return None
    result = {"filename": filename}
    for key, number in [("lineno", line), ("colno", column)]:
        if 0 < int(number) <= 1_000_000:
            result[key] = int(number)
    return result


def normalize_diagnostic(tags, point, code, safe_code):
    if tags.get("diagnostic_version") != "1":
        return None  # Legacy payloads stay valid and keep the original shape.
    error_type = tags.get("error_type")
    result = {
        "version": 1,
        "type": error_type if error_type in CONTRACT["types"] else "UnknownError",
        "code": code,
        "technical_cause": technical_cause(code),
        "technical_summary": CONTRACT["causeDescriptions"][technical_cause(code)],
        **CONTRACT["operations"][point],
        "frames": [], "causes": [], "correlation_id": None,
        "impact": tags.get("impact") if tags.get("impact") in CONTRACT["impacts"] else "unknown",
        "recovery": "unknown",
    }
    correlation = tags.get("correlation_id")
    if isinstance(correlation, str) and re.fullmatch(r"op_[a-f0-9]{32}", correlation, re.ASCII):
        result["correlation_id"] = correlation
    for i in range(CONTRACT["maxFrames"]):
        item = frame(tags.get(f"diagnostic_frame_{i}"))
        if item:
            result["frames"].append(item)
    for i in range(CONTRACT["maxCauses"]):
        error_type, nested_code = tags.get(f"cause_type_{i}"), tags.get(f"cause_code_{i}")
        if error_type in CONTRACT["types"] and safe_code(nested_code):
            result["causes"].append({"type": error_type, "code": nested_code, "technical_cause": technical_cause(nested_code), "technical_summary": CONTRACT["causeDescriptions"][technical_cause(nested_code)]})
    return result


def schema():
    cause = {"type": "object", "properties": {
        "type": {"type": "string", "enum": CONTRACT["types"]},
        "code": {"type": "string", "maxLength": 48},
        "technical_cause": {"type": "string", "enum": CONTRACT["causes"]},
        "technical_summary": {"type": "string", "enum": list(CONTRACT["causeDescriptions"].values())},
    }, "required": ["type", "code", "technical_cause", "technical_summary"], "additionalProperties": False}
    fields = {**cause["properties"],
        "version": {"type": "integer", "const": 1},
        "component": {"type": "string", "enum": sorted({v["component"] for v in CONTRACT["operations"].values()})},
        "operation": {"type": "string", "enum": sorted({v["operation"] for v in CONTRACT["operations"].values()})},
        "location": {"type": "string", "enum": sorted({v["location"] for v in CONTRACT["operations"].values()})},
        "correlation_id": {"type": ["string", "null"], "pattern": "^op_[a-f0-9]{32}$"},
        "impact": {"type": "string", "enum": CONTRACT["impacts"]},
        "recovery": {"type": "string", "enum": CONTRACT["recoveries"]},
        "causes": {"type": "array", "maxItems": CONTRACT["maxCauses"], "items": cause},
        "frames": {"type": "array", "maxItems": CONTRACT["maxFrames"], "items": {
            "type": "object", "properties": {
                "filename": {"type": "string", "maxLength": 180},
                "lineno": {"type": "integer", "minimum": 1, "maximum": 1_000_000},
                "colno": {"type": "integer", "minimum": 1, "maximum": 1_000_000},
            }, "required": ["filename"], "additionalProperties": False,
        }},
    }
    return {"type": "object", "properties": fields, "required": list(fields), "additionalProperties": False}
