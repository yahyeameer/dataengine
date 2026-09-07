"""
Reading what a shop actually pasted, and never leaking it.

The setup flow's whole premise is that a shopkeeper should not have to know
what a refresh token is. They paste whatever their accountant or integrator
sent, and the agent works it out. So these tests are mostly about *shapes of
real handover files* -- Intuit's JSON, an integrator's .env, an email with two
labelled lines, a bare key on its own -- and about the boundary that makes the
convenience safe: a value must never reach a log, a job result, an audit row or
a model.
"""

from __future__ import annotations

import json

import pytest

from hermes.connectors.credentials import (
    CredentialDraft,
    apply_mapping,
    mask,
    parse_credentials,
    role_for,
)
from hermes.tools import somali

SECRET = "AB1234567890secretvalue0987654321XY"


class TestShapesPeopleActuallyPaste:
    def test_intuit_style_json(self):
        blob = json.dumps(
            {
                "clientId": "ABxyz",
                "clientSecret": SECRET,
                "refreshToken": "RT-0001",
                "realmId": "9130350000",
            }
        )
        draft = parse_credentials(blob, "quickbooks")
        assert draft.complete
        assert draft.input_format == "json"
        assert draft.fields["client_secret"] == SECRET
        assert draft.understood["realm_id"] == "realmId"

    def test_nested_json_because_vendors_nest(self):
        blob = json.dumps(
            {
                "Suuqa Hodan": {
                    "production": {
                        "client_id": "A",
                        "client_secret": "B",
                        "refresh_token": "C",
                        "company_id": "D",
                    }
                }
            }
        )
        draft = parse_credentials(blob, "quickbooks")
        assert draft.complete
        assert draft.fields["realm_id"] == "D"

    def test_dotenv_lines_with_a_vendor_prefix(self):
        blob = """
        # from the integrator
        ODOO_URL=https://dukaanka.odoo.com
        ODOO_DB=hodan_live
        ODOO_USERNAME=api@hodan.so
        ODOO_API_KEY=xyz-key-0001
        """
        draft = parse_credentials(blob, "odoo")
        assert draft.complete
        assert draft.input_format == "lines"
        assert draft.fields["base_url"] == "https://dukaanka.odoo.com"
        assert draft.fields["database"] == "hodan_live"

    def test_an_email_with_labelled_lines(self):
        blob = """
        Hi, here are the details for your Odoo:

        Address: https://hodan.odoo.com
        Database: hodan-prod
        User: yahye@hodan.so
        API key: k-99887766
        """
        draft = parse_credentials(blob, "odoo")
        assert draft.complete
        assert draft.fields["api_key"] == "k-99887766"

    def test_export_lines_from_a_shell_snippet(self):
        draft = parse_credentials(
            "export ODOO_URL=https://a.odoo.com\nexport ODOO_DB=b\n"
            "export ODOO_USER=c\nexport ODOO_KEY=d",
            "odoo",
        )
        assert draft.complete

    def test_a_bare_odoo_key_on_its_own(self):
        """The commonest real case: the integrator sends only the key."""
        draft = parse_credentials("kx-0099-abcd", "odoo")
        assert draft.fields["api_key"] == "kx-0099-abcd"
        assert draft.input_format == "value"
        # Everything else is still missing, and it says so.
        assert set(draft.missing) == {"base_url", "database", "username"}

    def test_an_address_without_https_is_repaired_and_the_repair_is_stated(self):
        draft = parse_credentials("URL: dukaanka.odoo.com\nDB: x\nUser: y\nKey: z", "odoo")
        assert draft.fields["base_url"] == "https://dukaanka.odoo.com"
        assert any("https" in note for note in draft.notes)

    def test_the_url_colon_is_not_read_as_a_separator(self):
        draft = parse_credentials("https://hodan.odoo.com", "odoo")
        assert draft.fields["base_url"] == "https://hodan.odoo.com"
        assert draft.input_format == "url"

    def test_nothing_pasted_is_answered_rather_than_raised(self):
        draft = parse_credentials("", "odoo")
        assert draft.fields == {}
        assert draft.notes


class TestAmbiguity:
    def test_token_means_the_api_key_for_odoo(self):
        assert role_for("token", "odoo") == "api_key"

    def test_token_is_left_unresolved_for_quickbooks(self):
        """
        It could be the refresh token or the client secret. A guess locks the
        owner out of their own company file with an error that looks like their
        fault, so the deterministic pass declines and the name goes to the
        model — which never sees what the token contains.
        """
        assert role_for("token", "quickbooks") is None

    def test_a_specific_alias_beats_a_general_one(self):
        assert role_for("my_client_secret_value", "quickbooks") == "client_secret"

    def test_a_key_listed_twice_keeps_the_first(self):
        draft = parse_credentials(
            "API_KEY=live-key\n# API_KEY=example-key-do-not-use", "odoo"
        )
        assert draft.fields["api_key"] == "live-key"

    def test_unplaceable_names_are_reported_by_name(self):
        draft = parse_credentials("Furaha_Odoo=abc\nURL=https://a.odoo.com", "odoo")
        assert "Furaha_Odoo" in draft.unresolved


class TestNothingLeaks:
    """
    The convenience only stays safe if the reporting side holds no value. These
    assert that by construction rather than by inspection of one field at a
    time: whatever a draft reports outward, the secret must not be in it.
    """

    @pytest.fixture
    def draft(self) -> CredentialDraft:
        return parse_credentials(
            json.dumps(
                {
                    "clientId": "public-ish",
                    "clientSecret": SECRET,
                    "refreshToken": "RT-" + SECRET,
                    "realmId": "9130350000",
                }
            ),
            "quickbooks",
        )

    def test_the_summary_a_job_result_carries_holds_no_value(self, draft):
        blob = json.dumps(draft.summary())
        assert SECRET not in blob
        assert "RT-" + SECRET not in blob
        # And it is still useful: it names what was understood.
        assert "clientSecret" in blob

    def test_masking_shows_the_ends_and_hides_a_short_secret_entirely(self):
        assert mask(SECRET).startswith("AB12")
        assert SECRET[4:-4] not in mask(SECRET)
        assert mask("short") == "•••••"

    def test_a_setting_is_shown_in_full_and_a_secret_is_not(self):
        """
        The owner is being asked "is that your shop?", and a masked address is
        a question nobody can answer. The split is the same one that decides
        what reaches the vault.
        """
        draft = parse_credentials(
            "URL=https://hodan.odoo.com\nDB=hodan_live\nUser=api@hodan.so\nKEY=" + SECRET,
            "odoo",
        )
        assert draft.masked["base_url"] == "https://hodan.odoo.com"
        assert draft.masked["database"] == "hodan_live"
        assert SECRET not in draft.masked["api_key"]

    def test_the_public_half_and_the_secret_half_are_separated(self, draft):
        assert "client_secret" in draft.secret()
        assert "client_secret" not in draft.public()
        assert draft.public()["realm_id"] == "9130350000"

    def test_an_odoo_address_is_public_and_its_key_is_not(self):
        draft = parse_credentials(
            "URL=https://a.odoo.com\nDB=b\nUser=c\nKEY=" + SECRET, "odoo"
        )
        assert set(draft.public()) == {"base_url", "database", "username"}
        assert set(draft.secret()) == {"api_key"}


class TestTheModelSeesNamesOnly:
    """
    `map_credential_names` takes a list of strings, so the boundary is the
    signature rather than a rule someone has to remember. These prove the
    caller's side of it: the mapping comes back as names, and the values are
    re-attached here, in this process, from text that never left it.
    """

    def test_a_mapping_fills_a_role_from_the_original_text(self):
        raw = "Furaha_Odoo=super-secret-key\nURL=https://a.odoo.com\nDB=b\nUser=c"
        draft = parse_credentials(raw, "odoo")
        assert "api_key" in draft.missing

        apply_mapping(draft, {"Furaha_Odoo": "api_key"}, raw)
        assert draft.fields["api_key"] == "super-secret-key"
        assert draft.complete
        assert "Furaha_Odoo" not in draft.unresolved
        # And it says the agent did it, rather than passing it off as a match.
        assert any("agent" in note for note in draft.notes)

    def test_a_mapping_naming_a_role_this_source_does_not_use_is_ignored(self):
        raw = "Weird=x\nURL=https://a.odoo.com\nDB=b\nUser=c\nKEY=k"
        draft = parse_credentials(raw, "odoo")
        apply_mapping(draft, {"Weird": "refresh_token"}, raw)
        assert "refresh_token" not in draft.fields

    def test_a_mapping_cannot_overwrite_something_already_understood(self):
        raw = "API_KEY=real\nOther=decoy\nURL=https://a.odoo.com\nDB=b\nUser=c"
        draft = parse_credentials(raw, "odoo")
        apply_mapping(draft, {"Other": "api_key"}, raw)
        assert draft.fields["api_key"] == "real"

    def test_the_router_refuses_a_name_that_carries_a_value(self):
        """
        Belt and braces on the guarantee: a future caller that passes
        `client_secret=abc123` as a "name" must have it dropped rather than
        sent, because a docstring is not a control.
        """
        from hermes.config import LLMConfig
        from hermes.llm.router import LLMRouter

        router = LLMRouter(LLMConfig(openai_api_key="sk-test"))
        try:
            sent: dict = {}

            def fake_complete(task, system, user, **kwargs):
                sent["user"] = user
                from hermes.llm.router import LLMResult

                return LLMResult('{"mapping": {}}', "openai", "m", True)

            router._complete = fake_complete  # type: ignore[assignment]
            router.map_credential_names(
                "odoo", ["api_key=" + SECRET, "Furaha_Odoo"], ["api_key"]
            )
            assert SECRET not in sent["user"]
            assert "Furaha_Odoo" in sent["user"]
        finally:
            router.close()

    def test_no_model_call_happens_at_all_when_nothing_is_unresolved(self):
        from hermes.config import LLMConfig
        from hermes.llm.router import LLMRouter

        router = LLMRouter(LLMConfig(openai_api_key="sk-test"))
        try:
            called = False

            def fake_complete(*_args, **_kwargs):
                nonlocal called
                called = True
                raise AssertionError("the model was consulted needlessly")

            router._complete = fake_complete  # type: ignore[assignment]
            mapping, model = router.map_credential_names("odoo", [], ["api_key"])
            assert mapping == {} and model is None and not called
        finally:
            router.close()


class TestBothLanguages:
    def test_every_field_a_shop_must_supply_has_a_somali_label(self):
        from hermes.connectors.credentials import REQUIRED_FIELDS

        for source, roles in REQUIRED_FIELDS.items():
            for role in roles:
                label = somali.field_label(role, "so")
                assert label and label != role, f"{source}.{role} has no Somali label"

    def test_the_verdicts_a_shop_can_see_exist_in_both_languages(self):
        for code in somali.CONNECTION_MESSAGES:
            english = somali.connection_message(code, "en", company="X", fields="Y",
                                                system="Z", detail="D")
            somali_text = somali.connection_message(code, "so", company="X", fields="Y",
                                                    system="Z", detail="D")
            assert english and somali_text
            assert english != somali_text, f"{code} is not translated"
            assert "{" not in somali_text
