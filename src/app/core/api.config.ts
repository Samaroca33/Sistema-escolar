// ============================================================================
// CONFIGURAÇÃO DE REDE — altere apenas API_HOST se o back-end estiver em
// outro computador.
//
// • Deixe API_HOST = '' (vazio) quando o front-end e o Spring Boot rodam na
//   MESMA máquina. Nesse caso as URLs ficam relativas (/api, /ws) e funcionam
//   automaticamente em qualquer computador que abra o site — porque quem
//   responde é o próprio servidor que entregou a página.
//
// • Preencha com o IP do servidor (ex.: '10.86.142.29') quando o front-end for
//   servido de outra origem.
//
// Exemplos:
//   export const API_HOST = '';                  // mesmo servidor (recomendado)
//   export const API_HOST = '10.86.142.29';      // servidor fixo na rede
//   export const API_HOST = '10.86.142.29:8080'; // com porta explícita
// ============================================================================
export const API_HOST = '';

const sameOrigin =
	typeof window !== 'undefined' && window.location?.origin
		? window.location.origin
		: 'http://localhost';

/** Origem HTTP da API. Com API_HOST vazio, usa a própria origem da página. */
function resolveOrigin(): string {
	if (!API_HOST) return sameOrigin;
	const withScheme = /^https?:\/\//i.test(API_HOST)
		? API_HOST
		: `http://${API_HOST}`;
	return withScheme.replace(/\/+$/, '');
}

const ORIGIN = resolveOrigin();

/** Base da API REST (ex.: http://10.86.142.29/api). */
export const API_BASE_URL = `${ORIGIN}/api`;

/** WebSocket STOMP do Spring Boot, na mesma origem da API. */
export const WS_URL = `${ORIGIN.replace(/^http/i, 'ws')}/ws`;

/** Tópico onde o back-end publica as chamadas confirmadas. */
export const WS_TOPIC = '/topic/patio';

/** Intervalo (ms) da verificação de segurança da fila quando o WS está fora. */
export const QUEUE_FALLBACK_MS = 5000;
