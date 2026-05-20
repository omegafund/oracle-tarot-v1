// ════════════════════════════════════════════════════════════════════════
// V55PaymentContext.js — V55.0 클라이언트 헬퍼 (Phase 3)
// ════════════════════════════════════════════════════════════════════════
// 
// 사장님 검증 환경:
//   • Worker: https://tarot-api-merged.omegafund01.workers.dev
//   • Page:   https://oracle-tarot-v1.omegafund01.workers.dev/v55/
//
// ChatGPT 추가 권고 적용:
//   ✅ 추가 1: BFCache Recovery (pageshow persisted)
//   ✅ 추가 2: Polling AbortController (탭 폐쇄/뒤로가기 안전)
//   ✅ 추가 3: Client Session Lock (결제 버튼 연타 방지)
//   ✅ 추가 4: URL fragment + localStorage 보조 (offline recovery)
//   ✅ 추가 7: success.html 단순화 패턴 지원
//
// V54 위험 영역 ★ 절대 X ★:
//   ❌ paid_token (V55는 HMAC signedAccessToken)
//   ❌ cachedFullText (V55는 KV ownership)
//   ❌ isPaidUser 글로벌 변수
//   ❌ renderText 안에 결제 처리
// ════════════════════════════════════════════════════════════════════════

(function (global) {
    'use strict';

    // ════════════════════════════════════════════════════════════
    // 상수
    // ════════════════════════════════════════════════════════════
    const V55_VERSION = 'V202.55.0-phase3-cgpt';
    const WORKER_URL = 'https://tarot-api-merged.omegafund01.workers.dev';
    
    // localStorage 키
    const LS_KEY_READING_ID = 'v55_last_reading_id';
    const LS_KEY_TOKEN      = 'v55_last_token';
    const LS_KEY_ORDER_ID   = 'v55_last_order_id';
    const LS_KEY_TIMESTAMP  = 'v55_last_timestamp';
    
    // 24시간 후 localStorage 만료 (이전 결제 청소)
    const LS_TTL_MS = 24 * 60 * 60 * 1000;

    // ════════════════════════════════════════════════════════════
    // 세션 락 — ChatGPT 추가 3: Client Session Lock
    // ════════════════════════════════════════════════════════════
    //   결제 버튼 연타 방지
    //   모바일에서 사용자가 결제 버튼 빠르게 여러 번 누르는 경우 차단
    //   window 객체에 inflight 플래그 저장 (탭 단위 격리)
    
    function isInflight(key) {
        return global[`__v55_inflight_${key}`] === true;
    }
    
    function setInflight(key, value) {
        global[`__v55_inflight_${key}`] = value === true;
    }

    // ════════════════════════════════════════════════════════════
    // localStorage 안전 헬퍼 — ChatGPT 추가 4: Offline Recovery
    // ════════════════════════════════════════════════════════════
    //   카카오 인앱 격리 가능성 → try/catch 필수
    //   iOS Safari Private 모드 대응
    
    function safeStorageSet(key, value) {
        try {
            localStorage.setItem(key, value);
            return true;
        } catch (e) {
            console.warn('[V55] localStorage 사용 불가 (카카오 인앱 또는 Private 모드)', e.message);
            return false;
        }
    }
    
    function safeStorageGet(key) {
        try {
            return localStorage.getItem(key);
        } catch (e) {
            return null;
        }
    }
    
    function safeStorageRemove(key) {
        try {
            localStorage.removeItem(key);
        } catch (e) {}
    }
    
    /**
     * 마지막 결제 정보 저장 (offline recovery용)
     */
    function persistLastPayment(readingId, signedAccessToken, orderId) {
        const ts = Date.now();
        safeStorageSet(LS_KEY_READING_ID, readingId);
        safeStorageSet(LS_KEY_TOKEN, signedAccessToken);
        safeStorageSet(LS_KEY_ORDER_ID, orderId);
        safeStorageSet(LS_KEY_TIMESTAMP, String(ts));
    }
    
    /**
     * 마지막 결제 정보 조회 (24시간 내 결제만)
     */
    function readLastPayment() {
        const ts = parseInt(safeStorageGet(LS_KEY_TIMESTAMP) || '0', 10);
        if (!ts || Date.now() - ts > LS_TTL_MS) {
            // 만료된 경우 청소
            clearLastPayment();
            return null;
        }
        const readingId = safeStorageGet(LS_KEY_READING_ID);
        const token     = safeStorageGet(LS_KEY_TOKEN);
        const orderId   = safeStorageGet(LS_KEY_ORDER_ID);
        if (!readingId || !token) return null;
        return { readingId, signedAccessToken: token, orderId, timestamp: ts };
    }
    
    function clearLastPayment() {
        safeStorageRemove(LS_KEY_READING_ID);
        safeStorageRemove(LS_KEY_TOKEN);
        safeStorageRemove(LS_KEY_ORDER_ID);
        safeStorageRemove(LS_KEY_TIMESTAMP);
    }

    // ════════════════════════════════════════════════════════════
    // URL 파라미터 헬퍼 — ChatGPT 추가 4: URL fragment 우선
    // ════════════════════════════════════════════════════════════
    //   URL search params + hash params 모두 지원
    //   카카오 인앱에서 localStorage 격리 시 URL primary 사용
    
    function readUrlParams() {
        const url = new URL(window.location.href);
        const params = new URLSearchParams(url.search);
        // hash fragment도 검사 (#rid=xxx&token=xxx 형식)
        const hashStr = url.hash.startsWith('#') ? url.hash.substring(1) : url.hash;
        const hashParams = new URLSearchParams(hashStr);
        
        // hash가 우선 (보안: URL fragment는 referrer에 노출 안 됨)
        return {
            readingId:        hashParams.get('rid')   || params.get('rid'),
            signedAccessToken: hashParams.get('token') || params.get('token'),
            orderId:          hashParams.get('orderId')   || params.get('orderId'),
            paymentKey:       hashParams.get('paymentKey') || params.get('paymentKey'),
            amount:           hashParams.get('amount')     || params.get('amount')
        };
    }

    // ════════════════════════════════════════════════════════════
    // API: createReading
    // ════════════════════════════════════════════════════════════
    //   POST /v55/create-reading
    //   ChatGPT 추가 3: 세션 락 (결제 시작 시점)
    //   ChatGPT 추가 4: 성공 시 localStorage 저장
    
    async function createReading(input) {
        if (isInflight('create')) {
            throw new Error('이미 reading 생성 중 — 잠시 후 다시 시도');
        }
        setInflight('create', true);
        
        try {
            const response = await fetch(`${WORKER_URL}/v55/create-reading`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(input)
            });
            
            const data = await response.json();
            
            if (!response.ok || !data.readingId) {
                throw new Error(data.message || data.error || 'create-reading 실패');
            }
            
            // ★ ChatGPT 추가 4: 마지막 결제 정보 저장 (offline recovery) ★
            persistLastPayment(data.readingId, data.signedAccessToken, data.orderId);
            
            return data;
        } finally {
            setInflight('create', false);
        }
    }

    // ════════════════════════════════════════════════════════════
    // API: confirmPayment — ChatGPT 추가 3: 세션 락
    // ════════════════════════════════════════════════════════════
    //   POST /v55/confirm-payment
    //   결제 버튼 연타 차단 (window.__v55_inflight_confirm)
    //   호출 후에는 inflight 해제 X (응답 받을 때까지 차단)
    //   응답 후 자동 해제
    
    async function confirmPayment(args) {
        const { readingId, paymentKey, orderId, amount, signedAccessToken } = args;
        
        if (!readingId || !paymentKey || !orderId || !amount || !signedAccessToken) {
            throw new Error('필수 인수 누락: readingId, paymentKey, orderId, amount, signedAccessToken');
        }
        
        if (isInflight('confirm')) {
            console.warn('[V55] confirm-payment 이미 진행 중 — 무시 (★ 연타 차단 ★)');
            return { valid: false, error: 'IN_PROGRESS', message: '결제 검증 진행 중' };
        }
        
        setInflight('confirm', true);
        
        try {
            const response = await fetch(`${WORKER_URL}/v55/confirm-payment`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    readingId,
                    paymentKey,
                    orderId,
                    amount: Number(amount),
                    signedAccessToken
                })
            });
            
            const data = await response.json();
            return data;
        } finally {
            setInflight('confirm', false);
        }
    }

    // ════════════════════════════════════════════════════════════
    // API: pollReading — ChatGPT 추가 2: AbortController
    // ════════════════════════════════════════════════════════════
    //   GET /v55/fetch-reading?rid=xxx&token=xxx&poll=N
    //   AbortController로 강제 중단 가능
    //   탭 폐쇄/뒤로가기 시 polling 자동 중단
    //   pageshow persisted 시 다시 시작 가능
    
    /**
     * Polling 시작 + 결과 콜백
     * @param {Object} args - {readingId, signedAccessToken, onUpdate, onComplete, onFail}
     * @returns {Object} controller - {abort: () => void, isActive: () => boolean}
     */
    function pollReading(args) {
        const { readingId, signedAccessToken, onUpdate, onComplete, onFail } = args;
        
        const abortController = new AbortController();
        let pollCount = 0;
        let isActive = true;
        let currentTimer = null;
        
        async function doPoll() {
            if (!isActive) return;
            
            try {
                const url = `${WORKER_URL}/v55/fetch-reading?rid=${encodeURIComponent(readingId)}&token=${encodeURIComponent(signedAccessToken)}&poll=${pollCount}`;
                
                const response = await fetch(url, {
                    method: 'GET',
                    signal: abortController.signal
                });
                
                const data = await response.json();
                
                if (!isActive) return;  // abort 후 응답 도착 가능
                
                // 상태별 처리
                if (data.status === 'ready') {
                    // ★ READY ★
                    isActive = false;
                    onComplete && onComplete(data);
                    return;
                }
                
                if (data.status === 'failed') {
                    // ★ FAILED ★
                    isActive = false;
                    onFail && onFail(data);
                    return;
                }
                
                if (data.status === 'fetching' || data.status === 'paid' || data.status === 'consumed' || data.status === 'confirming') {
                    // ★ Polling 계속 ★
                    onUpdate && onUpdate(data);
                    
                    pollCount = data.pollCount || (pollCount + 1);
                    const retryAfterSec = data.retryAfterSec || 2;
                    
                    currentTimer = setTimeout(doPoll, retryAfterSec * 1000);
                    return;
                }
                
                if (data.status === 'created' || data.status === 'paying') {
                    // 결제 안 됨 (이상 상황)
                    isActive = false;
                    onFail && onFail({ error: 'NOT_PAID', message: '결제 미완료', status: data.status });
                    return;
                }
                
                // 기타
                isActive = false;
                onFail && onFail({ error: 'UNKNOWN_STATUS', message: `예상치 못한 상태: ${data.status}`, raw: data });
                
            } catch (e) {
                if (e.name === 'AbortError') {
                    // 정상 중단
                    return;
                }
                
                if (!isActive) return;
                
                // 네트워크 오류 — 재시도
                console.warn('[V55 polling 오류]', e.message);
                if (pollCount < 30) {  // 최대 30회 (약 4분)
                    pollCount += 1;
                    currentTimer = setTimeout(doPoll, 3000);
                } else {
                    isActive = false;
                    onFail && onFail({ error: 'NETWORK_ERROR', message: e.message });
                }
            }
        }
        
        // 즉시 시작
        doPoll();
        
        // 컨트롤러 반환
        return {
            abort: () => {
                isActive = false;
                abortController.abort();
                if (currentTimer) {
                    clearTimeout(currentTimer);
                    currentTimer = null;
                }
            },
            isActive: () => isActive
        };
    }

    // ════════════════════════════════════════════════════════════
    // BFCache Recovery — ChatGPT 추가 1
    // ════════════════════════════════════════════════════════════
    //   카카오 인앱브라우저 = pageshow persisted 매우 흔함
    //   결제 → 카카오 인앱 복귀 → JavaScript 변수 잃음
    //   pageshow 이벤트로 복귀 감지 → polling 재시작
    
    /**
     * BFCache 복귀 시 자동 polling 재시작
     * 페이지에 polling 컨트롤러가 있으면 호출하여 재 polling
     * 
     * @param {Function} onRestore - 복귀 시 호출되는 콜백
     *                                전달: {readingId, signedAccessToken, orderId}
     */
    function setupBFCacheRecovery(onRestore) {
        window.addEventListener('pageshow', function (event) {
            if (event.persisted) {
                console.log('[V55 BFCache] pageshow persisted 감지 — restore 시도');
                
                // 1. URL params 시도
                const urlParams = readUrlParams();
                if (urlParams.readingId && urlParams.signedAccessToken) {
                    onRestore && onRestore({
                        source: 'url',
                        readingId: urlParams.readingId,
                        signedAccessToken: urlParams.signedAccessToken,
                        orderId: urlParams.orderId
                    });
                    return;
                }
                
                // 2. localStorage 시도
                const lastPayment = readLastPayment();
                if (lastPayment) {
                    onRestore && onRestore({
                        source: 'localStorage',
                        readingId: lastPayment.readingId,
                        signedAccessToken: lastPayment.signedAccessToken,
                        orderId: lastPayment.orderId
                    });
                    return;
                }
                
                console.log('[V55 BFCache] restore 정보 없음');
            }
        });
    }

    // ════════════════════════════════════════════════════════════
    // 통합 헬퍼 — Mock 결제 흐름 (사장님 검증용)
    // ════════════════════════════════════════════════════════════
    //   토스 결제 없이 V55 워커 흐름 검증
    //   create → mockConfirm (가짜 paymentKey) → polling
    
    /**
     * Mock 결제 (★ 사장님 검증 ★)
     * 토스 결제 거치지 않고 V55 워커 호출만 검증
     * 토스 검증 거부 응답이 정상 (★ 흐름 검증 ★)
     */
    async function mockPayment(input) {
        // 1. createReading
        console.log('[V55 Mock] createReading 시작...');
        const created = await createReading(input);
        console.log('[V55 Mock] createReading 성공:', created.readingId);
        
        // 2. fake confirmPayment (토스 거부 응답이 정상)
        console.log('[V55 Mock] confirmPayment 시도 (토스 거부 응답 기대)...');
        const confirmed = await confirmPayment({
            readingId:         created.readingId,
            paymentKey:        'mock_payment_key_' + Date.now(),
            orderId:           created.orderId,
            amount:            created.amount,
            signedAccessToken: created.signedAccessToken
        });
        
        console.log('[V55 Mock] confirmPayment 결과:', confirmed);
        return { created, confirmed };
    }
    
    /**
     * 실제 결제 후 흐름 (Phase 4에서 사용)
     * 토스 success.html에서 호출
     */
    async function processSuccessCallback() {
        const params = readUrlParams();
        
        if (!params.readingId || !params.paymentKey || !params.orderId || !params.amount) {
            throw new Error('필수 파라미터 누락 (rid, paymentKey, orderId, amount)');
        }
        
        // signedAccessToken 복구 (URL params 또는 localStorage)
        let token = params.signedAccessToken;
        if (!token) {
            const last = readLastPayment();
            if (last && last.readingId === params.readingId) {
                token = last.signedAccessToken;
            }
        }
        
        if (!token) {
            throw new Error('signedAccessToken 복구 실패');
        }
        
        // confirmPayment 호출
        return await confirmPayment({
            readingId:         params.readingId,
            paymentKey:        params.paymentKey,
            orderId:           params.orderId,
            amount:            params.amount,
            signedAccessToken: token
        });
    }

    // ════════════════════════════════════════════════════════════
    // Public API
    // ════════════════════════════════════════════════════════════
    global.V55PaymentContext = {
        VERSION: V55_VERSION,
        WORKER_URL,
        
        // API 호출
        createReading,
        confirmPayment,
        pollReading,
        
        // BFCache + Offline Recovery
        setupBFCacheRecovery,
        readUrlParams,
        readLastPayment,
        persistLastPayment,
        clearLastPayment,
        
        // Mock 검증
        mockPayment,
        processSuccessCallback,
        
        // 내부 (디버깅용)
        _internal: {
            isInflight,
            setInflight,
            safeStorageGet,
            safeStorageSet
        }
    };
    
    console.log(`[V55PaymentContext] ${V55_VERSION} 로드 완료 — Worker: ${WORKER_URL}`);

})(typeof window !== 'undefined' ? window : globalThis);
