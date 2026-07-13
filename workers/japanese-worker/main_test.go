package main

import (
	"bytes"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	haiku "github.com/0x307e/go-haiku"
	"github.com/ikawaha/kagome-dict/uni"
	"github.com/ikawaha/kagome/v2/tokenizer"
)

func newTestApp(t *testing.T) *app {
	t.Helper()
	tok, err := tokenizer.New(uni.Dict(), tokenizer.OmitBosEos())
	if err != nil {
		t.Fatalf("tokenizer init failed: %v", err)
	}
	haiku.UseDict(uni.Dict())
	return &app{tokenizer: tok}
}

func postJSON(handler http.HandlerFunc, body string) *httptest.ResponseRecorder {
	req := httptest.NewRequest(http.MethodPost, "/", bytes.NewBufferString(body))
	req.Header.Set("content-type", "application/json")
	rec := httptest.NewRecorder()
	recoverHandler(handler)(rec, req)
	return rec
}

func TestValidateLoopbackAddr(t *testing.T) {
	if err := validateLoopbackAddr("127.0.0.1:8787"); err != nil {
		t.Fatalf("loopback should be valid: %v", err)
	}
	if err := validateLoopbackAddr("0.0.0.0:8787"); err == nil {
		t.Fatal("non-loopback should be invalid")
	}
}

func TestSanitizeAnalysisText(t *testing.T) {
	got := sanitizeAnalysisText("春風に https://example.com <@123> `code` コードが揺れて")
	if got != "春風に コードが揺れて" {
		t.Fatalf("unexpected sanitized text: %q", got)
	}
}

func TestHealth(t *testing.T) {
	a := newTestApp(t)
	req := httptest.NewRequest(http.MethodGet, "/health", nil)
	rec := httptest.NewRecorder()
	recoverHandler(a.handleHealth)(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("unexpected status: %d", rec.Code)
	}
	if !strings.Contains(rec.Body.String(), `"ok":true`) {
		t.Fatalf("unexpected body: %s", rec.Body.String())
	}
}

func TestAnalyzeSenryuNormal575(t *testing.T) {
	a := newTestApp(t)
	rec := postJSON(a.handleSenryu, `{"content":"古池や蛙飛び込む水の音","rule":[5,7,5]}`)
	if rec.Code != http.StatusOK {
		t.Fatalf("unexpected status: %d body=%s", rec.Code, rec.Body.String())
	}
	if !strings.Contains(rec.Body.String(), `"matched":true`) {
		t.Fatalf("expected match: %s", rec.Body.String())
	}
}

func TestAnalyzeSenryuNon575(t *testing.T) {
	a := newTestApp(t)
	rec := postJSON(a.handleSenryu, `{"content":"これは川柳ではない","rule":[5,7,5]}`)
	if rec.Code != http.StatusOK {
		t.Fatalf("unexpected status: %d", rec.Code)
	}
	if !strings.Contains(rec.Body.String(), `"matched":false`) {
		t.Fatalf("expected no match: %s", rec.Body.String())
	}
}

func TestAnalyzeSenryuExcludedTokens(t *testing.T) {
	a := newTestApp(t)
	rec := postJSON(a.handleSenryu, `{"content":"https://example.com <@123>","rule":[5,7,5]}`)
	if rec.Code != http.StatusOK {
		t.Fatalf("unexpected status: %d", rec.Code)
	}
	if !strings.Contains(rec.Body.String(), `"matched":false`) {
		t.Fatalf("expected no match: %s", rec.Body.String())
	}
}

func TestAnalyzeMorphNouns(t *testing.T) {
	a := newTestApp(t)
	rec := postJSON(a.handleMorph, `{"content":"東京と猫"}`)
	if rec.Code != http.StatusOK {
		t.Fatalf("unexpected status: %d body=%s", rec.Code, rec.Body.String())
	}
	body := rec.Body.String()
	if !strings.Contains(body, `"isProperNoun":true`) {
		t.Fatalf("expected proper noun token: %s", body)
	}
	if !strings.Contains(body, `"surface":"猫"`) {
		t.Fatalf("expected common noun token: %s", body)
	}
}

func TestPanicRecover(t *testing.T) {
	req := httptest.NewRequest(http.MethodGet, "/panic", nil)
	rec := httptest.NewRecorder()
	recoverHandler(func(http.ResponseWriter, *http.Request) {
		panic("boom")
	})(rec, req)
	if rec.Code != http.StatusInternalServerError {
		t.Fatalf("unexpected status: %d", rec.Code)
	}
}
