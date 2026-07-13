package main

import (
	"encoding/json"
	"errors"
	"log"
	"net"
	"net/http"
	"os"
	"regexp"
	"strings"
	"time"

	haiku "github.com/0x307e/go-haiku"
	"github.com/ikawaha/kagome-dict/dict"
	"github.com/ikawaha/kagome-dict/uni"
	"github.com/ikawaha/kagome/v2/tokenizer"
)

const defaultAddr = "127.0.0.1:8787"
const maxRequestBytes = 64 * 1024

var excludedTextPattern = regexp.MustCompile("(?s)```.*?```|`[^`]*`|https?://\\S+|<a?:[A-Za-z0-9_~]+:\\d+>|<[@#][!&]?\\d+>|<@&\\d+>")

type healthResponse struct {
	OK bool `json:"ok"`
}

type senryuRequest struct {
	Content string `json:"content"`
	Rule    []int  `json:"rule"`
}

type senryuResponse struct {
	Matched bool     `json:"matched"`
	Text    *string  `json:"text"`
	Phrases []string `json:"phrases"`
	Error   *string  `json:"error"`
}

type morphRequest struct {
	Content string `json:"content"`
}

type morphToken struct {
	Surface      string   `json:"surface"`
	Base         string   `json:"base"`
	Reading      string   `json:"reading"`
	Pos          []string `json:"pos"`
	IsProperNoun bool     `json:"isProperNoun"`
	IsOov        bool     `json:"isOov"`
}

type morphResponse struct {
	Tokens []morphToken `json:"tokens"`
	Error  *string      `json:"error"`
}

type app struct {
	tokenizer *tokenizer.Tokenizer
	userDict  *dict.UserDict
}

func main() {
	addr := os.Getenv("JAPANESE_WORKER_ADDR")
	if strings.TrimSpace(addr) == "" {
		addr = defaultAddr
	}
	if err := validateLoopbackAddr(addr); err != nil {
		log.Fatal(err)
	}

	userDict, err := loadUserDictFromEnv()
	if err != nil {
		log.Fatal(err)
	}
	tokenizerOptions := []tokenizer.Option{tokenizer.OmitBosEos()}
	if userDict != nil {
		tokenizerOptions = append(tokenizerOptions, tokenizer.UserDict(userDict))
	}
	tok, err := tokenizer.New(uni.Dict(), tokenizerOptions...)
	if err != nil {
		log.Fatal(err)
	}
	haiku.UseDict(uni.Dict())

	a := &app{tokenizer: tok, userDict: userDict}
	mux := http.NewServeMux()
	mux.HandleFunc("/health", recoverHandler(a.handleHealth))
	mux.HandleFunc("/analyze/senryu", recoverHandler(a.handleSenryu))
	mux.HandleFunc("/analyze/morph", recoverHandler(a.handleMorph))

	server := &http.Server{
		Addr:              addr,
		Handler:           mux,
		ReadHeaderTimeout: 5 * time.Second,
		ReadTimeout:       10 * time.Second,
		WriteTimeout:      10 * time.Second,
		IdleTimeout:       60 * time.Second,
	}
	log.Printf("japanese worker listening on %s", addr)
	log.Fatal(server.ListenAndServe())
}

func loadUserDictFromEnv() (*dict.UserDict, error) {
	path := strings.TrimSpace(os.Getenv("JAPANESE_WORKER_USER_DICT_PATH"))
	if path == "" {
		return nil, nil
	}
	return dict.NewUserDict(path)
}

func recoverHandler(next http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		defer func() {
			if recovered := recover(); recovered != nil {
				writeJSON(w, http.StatusInternalServerError, map[string]any{"error": "internal_error"})
			}
		}()
		next(w, r)
	}
}

func validateLoopbackAddr(addr string) error {
	host, _, err := net.SplitHostPort(addr)
	if err != nil {
		return err
	}
	ip := net.ParseIP(host)
	if ip == nil {
		ips, lookupErr := net.LookupIP(host)
		if lookupErr != nil {
			return lookupErr
		}
		for _, resolved := range ips {
			if !resolved.IsLoopback() {
				return errors.New("worker must bind to loopback only")
			}
		}
		return nil
	}
	if !ip.IsLoopback() {
		return errors.New("worker must bind to loopback only")
	}
	return nil
}

func (a *app) handleHealth(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		w.WriteHeader(http.StatusMethodNotAllowed)
		return
	}
	writeJSON(w, http.StatusOK, healthResponse{OK: true})
}

func (a *app) handleSenryu(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		w.WriteHeader(http.StatusMethodNotAllowed)
		return
	}
	var req senryuRequest
	if !readJSON(w, r, &req) {
		return
	}
	rule := req.Rule
	if len(rule) == 0 {
		rule = []int{5, 7, 5}
	}
	if len(rule) != 3 || rule[0] != 5 || rule[1] != 7 || rule[2] != 5 {
		msg := "only strict 5-7-5 is supported"
		writeJSON(w, http.StatusBadRequest, senryuResponse{Matched: false, Text: nil, Phrases: []string{}, Error: &msg})
		return
	}
	cleaned := sanitizeAnalysisText(req.Content)
	if strings.TrimSpace(cleaned) == "" {
		writeJSON(w, http.StatusOK, senryuResponse{Matched: false, Text: nil, Phrases: []string{}, Error: nil})
		return
	}
	matches, err := haiku.FindWithOpt(cleaned, rule, &haiku.Opt{Dict: uni.Dict(), UserDict: a.userDict})
	if err != nil {
		msg := "senryu_analysis_failed"
		writeJSON(w, http.StatusInternalServerError, senryuResponse{Matched: false, Text: nil, Phrases: []string{}, Error: &msg})
		return
	}
	if len(matches) == 0 {
		writeJSON(w, http.StatusOK, senryuResponse{Matched: false, Text: nil, Phrases: []string{}, Error: nil})
		return
	}
	text := matches[0]
	phrases := strings.Fields(text)
	if len(phrases) != 3 {
		writeJSON(w, http.StatusOK, senryuResponse{Matched: false, Text: nil, Phrases: []string{}, Error: nil})
		return
	}
	writeJSON(w, http.StatusOK, senryuResponse{Matched: true, Text: &text, Phrases: phrases, Error: nil})
}

func (a *app) handleMorph(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		w.WriteHeader(http.StatusMethodNotAllowed)
		return
	}
	var req morphRequest
	if !readJSON(w, r, &req) {
		return
	}
	cleaned := sanitizeAnalysisText(req.Content)
	if strings.TrimSpace(cleaned) == "" {
		writeJSON(w, http.StatusOK, morphResponse{Tokens: []morphToken{}, Error: nil})
		return
	}
	rawTokens := a.tokenizer.Tokenize(cleaned)
	tokens := make([]morphToken, 0, len(rawTokens))
	for _, tok := range rawTokens {
		features := tok.Features()
		pos := compactPos(features)
		reading := featureOr(features, 9, tok.Surface)
		base := featureOr(features, 7, tok.Surface)
		if reading == "*" || reading == "" {
			reading = tok.Surface
		}
		if base == "*" || base == "" {
			base = tok.Surface
		}
		tokens = append(tokens, morphToken{
			Surface:      tok.Surface,
			Base:         base,
			Reading:      reading,
			Pos:          pos,
			IsProperNoun: contains(pos, "固有名詞"),
			IsOov:        len(features) < 7,
		})
	}
	writeJSON(w, http.StatusOK, morphResponse{Tokens: tokens, Error: nil})
}

func readJSON(w http.ResponseWriter, r *http.Request, out any) bool {
	r.Body = http.MaxBytesReader(w, r.Body, maxRequestBytes)
	decoder := json.NewDecoder(r.Body)
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(out); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": "invalid_json"})
		return false
	}
	return true
}

func writeJSON(w http.ResponseWriter, status int, value any) {
	w.Header().Set("content-type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(value)
}

func sanitizeAnalysisText(content string) string {
	cleaned := excludedTextPattern.ReplaceAllString(content, " ")
	return strings.Join(strings.Fields(cleaned), " ")
}

func compactPos(features []string) []string {
	pos := make([]string, 0, 4)
	for i := 0; i < len(features) && i < 4; i++ {
		if features[i] == "" || features[i] == "*" {
			continue
		}
		pos = append(pos, features[i])
	}
	if len(pos) == 0 {
		return []string{"未知語"}
	}
	return pos
}

func featureOr(features []string, index int, fallback string) string {
	if index >= 0 && index < len(features) {
		return features[index]
	}
	return fallback
}

func contains(values []string, needle string) bool {
	for _, value := range values {
		if value == needle {
			return true
		}
	}
	return false
}
