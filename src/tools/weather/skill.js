const MACEDONIA_LAT = 41.3134;
const MACEDONIA_LON = -81.4984;

const tools = [
  {
    name: "weather_current",
    description:
      "Get the current weather conditions for a location. Defaults to Macedonia, Ohio if no location is specified.",
    input_schema: {
      type: "object",
      properties: {
        lat: {
          type: "number",
          description: "Latitude. Defaults to Macedonia, Ohio.",
        },
        lon: {
          type: "number",
          description: "Longitude. Defaults to Macedonia, Ohio.",
        },
      },
      required: [],
    },
  },
  {
    name: "weather_forecast",
    description:
      "Get a 5-day / 3-hour weather forecast for a location. Defaults to Macedonia, Ohio if no location is specified.",
    input_schema: {
      type: "object",
      properties: {
        lat: {
          type: "number",
          description: "Latitude. Defaults to Macedonia, Ohio.",
        },
        lon: {
          type: "number",
          description: "Longitude. Defaults to Macedonia, Ohio.",
        },
      },
      required: [],
    },
  },
];

const systemPrompt = `

## Weather
- Use weather_current / weather_forecast, never web_search.
- Both default to Macedonia, Ohio; pass lat/lon for anywhere else.
`;

function formatCurrent(data) {
  const temp = data.main;
  const weather = data.weather[0];
  const wind = data.wind;
  return [
    `**${data.name}** — ${weather.description}`,
    `🌡️ ${temp.temp}°F (feels like ${temp.feels_like}°F)`,
    `  High: ${temp.temp_max}°F / Low: ${temp.temp_min}°F`,
    `💧 Humidity: ${temp.humidity}%`,
    `💨 Wind: ${wind.speed} mph${wind.gust ? ` (gusts ${wind.gust} mph)` : ""}`,
    `☁️ Cloud cover: ${data.clouds.all}%`,
    data.rain ? `🌧️ Rain (1h): ${data.rain["1h"]} mm` : null,
    data.snow ? `❄️ Snow (1h): ${data.snow["1h"]} mm` : null,
    `👁️ Visibility: ${(data.visibility / 1609.34).toFixed(1)} mi`,
  ]
    .filter(Boolean)
    .join("\n");
}

function formatForecast(data) {
  // Group by day
  const days = {};
  for (const entry of data.list) {
    const date = entry.dt_txt.split(" ")[0];
    if (!days[date]) days[date] = [];
    days[date].push(entry);
  }

  const lines = [`**5-Day Forecast for ${data.city.name}**\n`];
  for (const [date, entries] of Object.entries(days)) {
    const temps = entries.map((e) => e.main.temp);
    const high = Math.max(...temps);
    const low = Math.min(...temps);
    const conditions = [...new Set(entries.map((e) => e.weather[0].description))];
    const maxPop = Math.max(...entries.map((e) => e.pop || 0));

    lines.push(
      `**${date}**: ${low.toFixed(0)}°F – ${high.toFixed(0)}°F | ${conditions.join(", ")}${maxPop > 0.1 ? ` | ${(maxPop * 100).toFixed(0)}% precip` : ""}`
    );
  }
  return lines.join("\n");
}

function createHandler() {
  const apiKey = process.env.OPENWEATHER_API_KEY;

  if (!apiKey) {
    return async () => "Weather not configured — missing OPENWEATHER_API_KEY env var.";
  }

  return async (toolName, toolInput) => {
    const lat = toolInput.lat || MACEDONIA_LAT;
    const lon = toolInput.lon || MACEDONIA_LON;

    switch (toolName) {
      case "weather_current": {
        const url = `https://api.openweathermap.org/data/2.5/weather?lat=${lat}&lon=${lon}&appid=${apiKey}&units=imperial`;
        const res = await fetch(url);
        if (!res.ok) throw new Error(`OpenWeatherMap API error: ${res.status} ${await res.text()}`);
        const data = await res.json();
        return formatCurrent(data);
      }
      case "weather_forecast": {
        const url = `https://api.openweathermap.org/data/2.5/forecast?lat=${lat}&lon=${lon}&appid=${apiKey}&units=imperial`;
        const res = await fetch(url);
        if (!res.ok) throw new Error(`OpenWeatherMap API error: ${res.status} ${await res.text()}`);
        const data = await res.json();
        return formatForecast(data);
      }
    }
  };
}

export default { name: "weather", tools, systemPrompt, createHandler };
