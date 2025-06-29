// Bot_CCI_v5_With_VolumeDelta_and_ATR_Targets.js
require("dotenv").config();
const axios = require("axios");
const { Telegraf } = require("telegraf");
const { RSI, ATR } = require("technicalindicators");
const { Decimal } = require("decimal.js");
const WebSocket = require("ws");

// ================= CONFIG ================= //
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const PARES_MONITORADOS = (process.env.PARES_MONITORADOS || "BTCUSDT,ETHUSDT").split(",");
const INTERVALO_VERIFICACAO_MS = parseInt(process.env.INTERVALO_VERIFICACAO_MS || "300000", 10);
const LEVERAGE_DEFAULT = parseInt(process.env.LEVERAGE_DEFAULT || "5");
const CCI_PERIOD = 20;
const CCI_SMA_PERIOD = 14;
const EMA_3M_PERIODS = [17,34];
const RSI_PERIOD = 14;
const ATR_PERIOD = 14;

// --- ATR and Target Config --- //
const ATR_REENTRY_MULTIPLIER = new Decimal(process.env.ATR_REENTRY_MULTIPLIER || "1.0");
const ATR_FINAL_STOP_MULTIPLIER = new Decimal(process.env.ATR_FINAL_STOP_MULTIPLIER || "3.0");
const TARGET_1_ATR_MULT = new Decimal(process.env.TARGET_1_ATR_MULT || "2");
const TARGET_2_ATR_MULT = new Decimal(process.env.TARGET_2_ATR_MULT || "3");
const TARGET_3_ATR_MULT = new Decimal(process.env.TARGET_3_ATR_MULT || "4");

// --- LSR Thresholds --- //
const LSR_BUY_THRESHOLD = new Decimal(1.8);
const LSR_SELL_THRESHOLD = new Decimal(2.0);

// --- OI Percentage Change Thresholds --- //
const OI_PERCENT_CHANGE_THRESHOLD = new Decimal(0.20); // 0.20% threshold for OI change

// --- Volume Delta Threshold --- //
const VOLUME_DELTA_THRESHOLD = new Decimal(0.1); // Threshold for normalized delta (e.g., 0.1 means 10% more buy/sell volume)

// ============ ANTI-SPAM DE SINAIS =========== //
const ultimosSinais = {}; // { "<par>_LONG" ou "<par>_SHORT": timestamp }
const TEMPO_MINIMO_ENTRE_SINAIS_MS = 30 * 60 * 1000; // 30 minutos

// ============ VOLUME DELTA STORAGE =========== //
const volumeDeltaStore = {}; // { "BTCUSDT": { buyVolume: Decimal, sellVolume: Decimal, normalizedDelta: Decimal, lastUpdated: timestamp } }

// ================= HELPER FUNCTIONS ================= //
function formatDecimal(value, places = 5) {
    if (value === null || value === undefined) return "N/A";
    try {
        return (value instanceof Decimal ? value : new Decimal(value)).toDecimalPlaces(places).toString();
    } catch {
        return "N/A";
    }
}

function calculatePercentChange(current, previous) {
    if (!current || !previous || previous.isZero()) return { value: null, formatted: "N/A" };
    try {
        const change = current.minus(previous);
        const percentChange = change.dividedBy(previous).times(100);
        const status = percentChange.isPositive() ? "(Subiu)" : percentChange.isNegative() ? "(Caiu)" : "(Manteve)";
        return { value: percentChange, formatted: `${formatDecimal(percentChange, 2)}% ${status}` };
    } catch (e) {
        console.error(`[Percent Calc] Erro: ${e.message}`);
        return { value: null, formatted: "N/A (Erro)" };
    }
}

function getEMASeries(closes, period) {
    if (closes.length < period + 1) return { current: null, previous: null };
    try {
        const decimalCloses = closes.map(c => new Decimal(c));
        const multiplier = new Decimal(2).dividedBy(period + 1);
        let ema = decimalCloses.slice(0, period).reduce((a, b) => a.plus(b), new Decimal(0)).dividedBy(period);
        let previousEma = null;
        for (let i = period; i < decimalCloses.length; i++) {
            previousEma = ema;
            ema = decimalCloses[i].minus(ema).times(multiplier).plus(ema);
        }
        return { current: ema, previous: previousEma };
    } catch (e) {
        console.error(`[EMA Series Calc ${period}] Erro: ${e.message}`);
        return { current: null, previous: null };
    }
}

function calculateATR(highs, lows, closes, period = ATR_PERIOD) {
    if (highs.length < period || lows.length < period || closes.length < period) return null;
    try {
        const result = ATR.calculate({ high: highs.map(Number), low: lows.map(Number), close: closes.map(Number), period });
        return result.length ? new Decimal(result[result.length - 1]) : null;
    } catch (e) {
        console.error(`[ATR Calc] Erro: ${e.message}`);
        return null;
    }
}

function calculateRSI(closes, period = RSI_PERIOD) {
    if (closes.length < period + 1) return null;
    try {
        const result = RSI.calculate({ values: closes.map(Number), period });
        return result.length ? new Decimal(result[result.length - 1]) : null;
    } catch (e) {
        console.error(`[RSI Calc] Erro: ${e.message}`);
        return null;
    }
}

function checkCrossover(fast, slow) {
    return fast.previous && slow.previous && fast.current && slow.current &&
        fast.previous.lte(slow.previous) && fast.current.gt(slow.current);
}

function checkCrossunder(fast, slow) {
    return fast.previous && slow.previous && fast.current && slow.current &&
        fast.previous.gte(slow.previous) && fast.current.lt(slow.current);
}

// Funções calculateCCI e calculateSMA
function calculateCCI(highs, lows, closes, period = CCI_PERIOD) {
    if (highs.length < period || lows.length < period || closes.length < period) return null;

    const typicalPrices = closes.map((c, i) => new Decimal(c).plus(new Decimal(highs[i])).plus(new Decimal(lows[i])).dividedBy(3));

    if (typicalPrices.length < period) return null;

    const lastTypicalPrices = typicalPrices.slice(-period);
    const sumTypicalPrices = lastTypicalPrices.reduce((a, b) => a.plus(b), new Decimal(0));
    const smaTypicalPrices = sumTypicalPrices.dividedBy(period);

    const meanDeviation = lastTypicalPrices.reduce((sum, tp) => sum.plus(tp.minus(smaTypicalPrices).abs()), new Decimal(0)).dividedBy(period);

    if (meanDeviation.isZero()) return new Decimal(0); // Evita divisão por zero

    const cci = typicalPrices[typicalPrices.length - 1].minus(smaTypicalPrices).dividedBy(new Decimal(0.015).times(meanDeviation));
    return cci;
}

function calculateSMA(values, period) {
    if (values.length < period) return null;
    const lastValues = values.slice(-period);
    const sum = lastValues.reduce((a, b) => a.plus(b), new Decimal(0));
    return sum.dividedBy(period);
}

// ================= WEBSOCKET VOLUME DELTA ================= //
function startVolumeDeltaSocket(symbol) {
    const ws = new WebSocket(`wss://fstream.binance.com/ws/${symbol.toLowerCase()}@trade`);

    // Initialize store for this symbol
    volumeDeltaStore[symbol] = { buyVolume: new Decimal(0), sellVolume: new Decimal(0), normalizedDelta: new Decimal(0), lastUpdated: Date.now() };

    ws.on("message", (data) => {
        try {
            const trade = JSON.parse(data.toString());
            // Use 'q' for quantity and 'm' for isBuyerMaker as per Binance aggTrade payload
            // 'm': true means the maker was the buyer, so the taker was the seller (SELL trade)
            // 'm': false means the maker was the seller, so the taker was the buyer (BUY trade)
            if (trade && trade.q !== undefined && trade.m !== undefined) {
                const quantity = new Decimal(trade.q);
                if (trade.m) { // If true, it's a sell trade (taker sold to maker)
                    volumeDeltaStore[symbol].sellVolume = volumeDeltaStore[symbol].sellVolume.plus(quantity);
                } else { // If false, it's a buy trade (taker bought from maker)
                    volumeDeltaStore[symbol].buyVolume = volumeDeltaStore[symbol].buyVolume.plus(quantity);
                }
                volumeDeltaStore[symbol].lastUpdated = Date.now();
            } else {
                console.warn(`[Volume Delta ${symbol}] trade.q ou trade.m é undefined ou null. Pulando este trade:`, trade);
            }
        } catch (e) {
            console.error(`[WS ${symbol}] Erro ao processar mensagem: ${e.message}`);
        }
    });

    ws.on("open", () => console.log(`[WS ${symbol}] Conectado ao WebSocket de trades.`));
    ws.on("close", () => console.log(`[WS ${symbol}] Desconectado do WebSocket de trades.`));
    ws.on("error", (err) => console.error(`[WS ${symbol}] Erro no WebSocket: ${err.message}`));
}

// Start WebSocket for each monitored pair
PARES_MONITORADOS.forEach(startVolumeDeltaSocket);

// Update normalized delta every minute
setInterval(() => {
    for (const symbol in volumeDeltaStore) {
        const data = volumeDeltaStore[symbol];
        const totalVolume = data.buyVolume.plus(data.sellVolume);
        if (!totalVolume.isZero()) {
            data.normalizedDelta = data.buyVolume.minus(data.sellVolume).dividedBy(totalVolume);
        } else {
            data.normalizedDelta = new Decimal(0); // Reset or set to 0 if no volume
        }
        // Reset volumes for next interval
        data.buyVolume = new Decimal(0);
        data.sellVolume = new Decimal(0);
        console.log(`[Volume Delta ${symbol}] Delta normalizado (1min): ${formatDecimal(data.normalizedDelta, 4)}`);
    }
}, 60000); // Update every minute

// ================= BOT ================= //
class TradingBot {
    constructor() {
        this.bot = new Telegraf(TELEGRAM_BOT_TOKEN);
    }

    async fetchKlines(symbol, interval, limit) {
        const url = "https://fapi.binance.com/fapi/v1/klines"; 
        try {
            const res = await axios.get(url, { params: { symbol, interval, limit } });
            return {
                highs: res.data.map(k => k[2]),
                lows: res.data.map(k => k[3]),
                closes: res.data.map(k => k[4]),
            };
        } catch (error) {
            console.error(`[Klines ${symbol} ${interval}] Erro: ${error.message}`);
            return { highs: [], lows: [], closes: [] };
        }
    }

    async fetchLSR(symbol) {
        const url = "https://fapi.binance.com/futures/data/globalLongShortAccountRatio"; 
        try {
            const res = await axios.get(url, { params: { symbol, period: "5m", limit: 2 } });
            if (res.data && res.data.length >= 2) {
                const [prev, curr] = res.data.slice(-2);
                return {
                    current: new Decimal(curr.longShortRatio),
                    previous: new Decimal(prev.longShortRatio)
                };
            }
        } catch (error) {
            console.error(`[LSR ${symbol}] Erro: ${error.message}`);
        }
        return { current: null, previous: null };
    }

    async fetchOpenInterest(symbol) {
        const url = "https://fapi.binance.com/futures/data/openInterestHist"; 
        try {
            const res = await axios.get(url, { params: { symbol, period: "5m", limit: 2 } });
            if (res.data && res.data.length >= 2) {
                const [prev, curr] = res.data.slice(-2);
                return {
                    current: new Decimal(curr.sumOpenInterestValue),
                    previous: new Decimal(prev.sumOpenInterestValue)
                };
            }
        } catch (error) {
            console.error(`[OI ${symbol}] Erro: ${error.message}`);
        }
        return { current: null, previous: null };
    }

    async sendAlert(msg) {
        try {
            await this.bot.telegram.sendMessage(TELEGRAM_CHAT_ID, msg, { parse_mode: "Markdown", disable_web_page_preview: true });
            console.log(`Alerta enviado para ${TELEGRAM_CHAT_ID}`);
        } catch (err) {
            console.error("Erro ao enviar alerta (Markdown):", err.message);
            try {
                const plainText = msg.replace(/[*_`[~#+=<>!.-]/g, (match) => `\\${match}`);
                await this.bot.telegram.sendMessage(TELEGRAM_CHAT_ID, plainText, { disable_web_page_preview: true });
                console.log(`Alerta enviado (texto plano) para ${TELEGRAM_CHAT_ID}`);
            } catch (plainErr) {
                console.error("Erro ao enviar alerta (texto plano):", plainErr.message);
            }
        }
    }

    async checkSignals() {
        console.log(`\n[${new Date().toISOString()}] Iniciando verificação...`);
        for (const par of PARES_MONITORADOS) {
            console.log(`--- Verificando ${par} ---`);
            try {
                const [data15m, data1h, data4h, data1d] = await Promise.all([
                    this.fetchKlines(par, "15m", 200),
                    this.fetchKlines(par, "1h", 100),
                    this.fetchKlines(par, "4h", 100),
                    this.fetchKlines(par, "1d", 100),
                ]);
                if (data15m.closes.length < 50 || data1h.closes.length < 50 || data4h.closes.length < 50) { // Added data4h check
                    console.log(`[${par}] Dados insuficientes (15m: ${data15m.closes.length}, 1h: ${data1h.closes.length}, 4h: ${data4h.closes.length}).`);
                    continue;
                }

                const ema17Series = getEMASeries(data15m.closes, 17);
                const ema13Series = getEMASeries(data15m.closes, 13);
                const ema34Series = getEMASeries(data15m.closes, 34);
                const currentRsi = calculateRSI(data15m.closes, RSI_PERIOD);
                const currentAtr = calculateATR(data15m.highs, data15m.lows, data15m.closes);
                const currentPrice = new Decimal(data15m.closes[data15m.closes.length - 1]);

                const currentCci = calculateCCI(data15m.highs, data15m.lows, data15m.closes);
                const cciValues = data15m.closes.map((c, i) =>
                    calculateCCI(
                        data15m.highs.slice(0, i + 1),
                        data15m.lows.slice(0, i + 1),
                        data15m.closes.slice(0, i + 1)
                    )
                ).filter(val => val !== null);
                const cciSma = calculateSMA(cciValues, CCI_SMA_PERIOD);

                const oiData = await this.fetchOpenInterest(par);
                const lsrData = await this.fetchLSR(par);

                const currentCci1h = calculateCCI(data1h.highs, data1h.lows, data1h.closes);
                const cci1hValues = data1h.closes.map((c, i) =>
                    calculateCCI(
                        data1h.highs.slice(0, i + 1),
                        data1h.lows.slice(0, i + 1),
                        data1h.closes.slice(0, i + 1)
                    )
                ).filter(val => val !== null);
                const cci1hSma = calculateSMA(cci1hValues, CCI_SMA_PERIOD);

                // CCI H4 for Long Signal
                const currentCci4h = calculateCCI(data4h.highs, data4h.lows, data4h.closes);

                // Get normalized volume delta for the current pair
                const currentNormalizedDelta = volumeDeltaStore[par] ? volumeDeltaStore[par].normalizedDelta : new Decimal(0);

                // Check if essential data is available
                if (
                    currentPrice === null || currentAtr === null ||
                    ema17Series.current === null || ema34Series.current === null ||
                    oiData.current === null || lsrData.current === null ||
                    currentCci1h === null || cci1hSma === null ||
                    currentCci4h === null || // Added CCI H4 check
                    volumeDeltaStore[par] === undefined // Check if volume delta is available
                ) {
                    console.log(`[${par}] Falha ao calcular dados essenciais ou Volume Delta não disponível. Pulando.`);
                    continue;
                }

                const oiChange = calculatePercentChange(oiData.current, oiData.previous);
                const lsrChange = calculatePercentChange(lsrData.current, lsrData.previous);

                // LONG SIGNAL
                const isCciLong = currentCci?.gt(cciSma) && currentCci?.gt(new Decimal(-100) && currentCci?.lt(new Decimal(200));
                const isCrossover = checkCrossover(ema17Series, ema34Series);
                const isOiUpEnough = oiChange.value?.isPositive() && oiChange.value?.gte(OI_PERCENT_CHANGE_THRESHOLD);
                const isLsrFalling = lsrChange.value?.isNegative();
                const lsrBelowThreshold = lsrData.current.lt(LSR_BUY_THRESHOLD);
                const isVolumeDeltaLong = currentNormalizedDelta.gt(VOLUME_DELTA_THRESHOLD); // Delta positivo
                const isCci4hBelow200 = currentCci4h?.lt(new Decimal(200)); // New condition for Long: CCI H4 < 200

                const chaveLong = `${par}_LONG`;
                const agora = Date.now();

                if (isCciLong && isCrossover && isOiUpEnough && isLsrFalling && lsrBelowThreshold && isVolumeDeltaLong && isCci4hBelow200) {
                    if (
                        ultimosSinais[chaveLong] &&
                        (agora - ultimosSinais[chaveLong]) < TEMPO_MINIMO_ENTRE_SINAIS_MS
                    ) {
                        console.log(`[${par}] Sinal LONG já enviado recentemente. Pulando...`);
                    } else {
                        const reentryPrice = currentPrice.minus(currentAtr.times(ATR_REENTRY_MULTIPLIER));
                        const finalStopLoss = currentPrice.minus(currentAtr.times(ATR_FINAL_STOP_MULTIPLIER));
                        const target1 = currentPrice.plus(currentAtr.times(TARGET_1_ATR_MULT));
                        const target2 = currentPrice.plus(currentAtr.times(TARGET_2_ATR_MULT));
                        const target3 = currentPrice.plus(currentAtr.times(TARGET_3_ATR_MULT));

                        const msg = `🟢 *LONG* (${par})
*Entrys:* ${formatDecimal(currentPrice, 5)} - ${formatDecimal(reentryPrice, 5)}
Leverage: ${LEVERAGE_DEFAULT}X
*Tps:* ${formatDecimal(target1, 5)} - ${formatDecimal(target2, 5)} - ${formatDecimal(target3, 5)}
*Stop Loss:* ${formatDecimal(finalStopLoss, 5)}`;
                        await this.sendAlert(msg);
                        console.log(`[${par}] Alerta LONG enviado.`);
                        ultimosSinais[chaveLong] = agora;
                    }
                }

                // SHORT SIGNAL
              
                const isCciShort = currentCci?.lt(cciSma) && currentCci?.lt(new Decimal(100)) && currentCci?.gt(new Decimal(-200));
                const isCci1hShort = currentCci1h?.lt(cci1hSma) && currentCci1h?.lt(new Decimal(100));
                const isCrossunder = checkCrossunder(ema17Series, ema34Series);
                const isOiDownEnough = oiChange.value?.isNegative() && oiChange.value?.abs().gte(OI_PERCENT_CHANGE_THRESHOLD);
                const isLsrRising = lsrChange.value?.isPositive();
                const lsrAboveThreshold = lsrData.current.gt(LSR_SELL_THRESHOLD);
                const isVolumeDeltaShort = currentNormalizedDelta.lt(VOLUME_DELTA_THRESHOLD.neg()); // Delta negativo

                const chaveShort = `${par}_SHORT`;

                if (
                    isCciShort && isCci1hShort && isCrossunder && isOiDownEnough && isLsrRising && lsrAboveThreshold && isVolumeDeltaShort
                ) {
                    if (
                        ultimosSinais[chaveShort] &&
                        (agora - ultimosSinais[chaveShort]) < TEMPO_MINIMO_ENTRE_SINAIS_MS
                    ) {
                        console.log(`[${par}] Sinal SHORT já enviado recentemente. Pulando...`);
                    } else {
                        const reentryPrice = currentPrice.plus(currentAtr.times(ATR_REENTRY_MULTIPLIER));
                        const finalStopLoss = currentPrice.plus(currentAtr.times(ATR_FINAL_STOP_MULTIPLIER));
                        const target1 = currentPrice.minus(currentAtr.times(TARGET_1_ATR_MULT));
                        const target2 = currentPrice.minus(currentAtr.times(TARGET_2_ATR_MULT));
                        const target3 = currentPrice.minus(currentAtr.times(TARGET_3_ATR_MULT));

                        const msg = `🔴 *SHORT* (${par})
*Entrys:* ${formatDecimal(currentPrice, 5)}-${formatDecimal(reentryPrice, 5)}
Leverage: ${LEVERAGE_DEFAULT}X
*Tps :*${formatDecimal(target1, 5)} - ${formatDecimal(target2, 5)} - ${formatDecimal(target3, 5)}
*Stop Loss:* ${formatDecimal(finalStopLoss, 5)}`;
                        await this.sendAlert(msg);
                        console.log(`[${par}] Alerta SHORT enviado.`);
                        ultimosSinais[chaveShort] = agora;
                    }
                }

            } catch (err) {
                console.error(`[${par}] Erro no loop principal:`, err.message, err.stack);
            }
            await new Promise(resolve => setTimeout(resolve, 1000));
        }
        console.log(`[${new Date().toISOString()}] Verificação concluída.`);
    }
}

// ================= EXECUÇÃO ================= //
if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) {
    console.error("ERRO: Variáveis de ambiente TELEGRAM_BOT_TOKEN e TELEGRAM_CHAT_ID devem ser definidas!");
    process.exit(1);
}

const botInstance = new TradingBot();
console.log("🤖 Bot (v5 - Delta + CCI H4) iniciando... Verificação de sinais a cada " + (INTERVALO_VERIFICACAO_MS / 1000 / 60) + " minutos.");

// Start the signal checking loop
setInterval(() => botInstance.checkSignals(), INTERVALO_VERIFICACAO_MS);

// Start the Telegram bot
botInstance.bot.launch();

// Enable graceful stop
process.once("SIGINT", () => botInstance.bot.stop("SIGINT"));
process.once("SIGTERM", () => botInstance.bot.stop("SIGTERM"));


