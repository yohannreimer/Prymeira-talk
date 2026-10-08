import copy
import json
import unittest
from support import CONFIG, PRIVATE, payload
from xing_alerts.privacy import normalize, InvalidPayload, POINTS, safe_code


class PrivacyTests(unittest.TestCase):
    def test_rebuilds_native_fields_and_never_private_content(self):
        events = normalize(payload(), CONFIG, 1000)
        text = json.dumps(events)
        self.assertNotIn(PRIVATE, text)
        self.assertNotIn("title", events[0])
        self.assertEqual(events[0]["failure_point"], "transport_delivery")
        self.assertEqual(events[0]["failure_code"], "ECONNRESET")
        self.assertEqual(events[0]["timestamp"], "1970-01-01T00:16:40Z")

    def test_other_project_mixed_payload_rejected_atomically(self):
        for name in ["pra-talk", "other-project"]:
            data = payload()
            other = copy.deepcopy(data["attachments"][0])
            other["fields"][0]["value"] = name
            data["attachments"].append(other)
            with self.subTest(name=name), self.assertRaises(InvalidPayload):
                normalize(data, CONFIG, 1000)

    def test_hostile_urls_never_survive(self):
        for suffix in [
            "?token=secret",
            "#phone",
            "/../issues/42",
            "/%34%32",
            "/42/extra",
        ]:
            data = payload()
            data["attachments"][0]["title_link"] += suffix
            with self.subTest(suffix=suffix), self.assertRaises(InvalidPayload):
                normalize(data, CONFIG, 1000)
        for url in [
            "http://glitchtip.prymeiradigital.com.br/prymeira-digital/issues/42",
            "https://glitchtip.prymeiradigital.com.br.evil/prymeira-digital/issues/42",
            "https://foo@glitchtip.prymeiradigital.com.br/prymeira-digital/issues/42",
            CONFIG.base_url + "/other/issues/42",
        ]:
            data = payload()
            data["attachments"][0]["title_link"] = url
            with self.subTest(url=url), self.assertRaises(InvalidPayload):
                normalize(data, CONFIG, 1000)

    def test_unknown_tags_fallback_and_duplicate_ambiguity_rejected(self):
        data = payload()
        for field in data["attachments"][0]["fields"][1:5]:
            field["value"] = PRIVATE
        result = normalize(data, CONFIG, 1000)[0]
        self.assertEqual(result["failure_point"], "fatal")
        self.assertEqual(result["failure_code"], "UNEXPECTED_ERROR")
        self.assertEqual(result["service"], "unknown")
        self.assertIsNone(result["release"])
        data["attachments"][0]["fields"].append({"title": "Project", "value": "other"})
        with self.assertRaises(InvalidPayload):
            normalize(data, CONFIG, 1000)

    def test_bounds_and_safe_code_contract(self):
        with self.assertRaises(InvalidPayload):
            normalize(
                {"attachments": [payload()["attachments"][0]] * 101}, CONFIG, 1000
            )
        for code in [
            "P1234",
            "HISTORY_HTTP_500",
            "EVOLUTION_HTTP_503",
            "INGRESS_PUBLISH_NACK",
            "INVALID_UNICODE",
            "UNEXPECTED_ERROR",
            "MEDIA_TOO_LARGE",
        ]:
            self.assertTrue(safe_code(code), code)
        for code in [
            PRIVATE,
            "P12345",
            "INGRESS_MADE_UP",
            "ECONNRESET\n",
            "MEDIA_TOO_LARGE " + PRIVATE,
        ]:
            self.assertFalse(safe_code(code), code)
        self.assertEqual(len(POINTS), 15)
