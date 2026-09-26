# Vênus Cine Backend

Backend modular em Node.js + Express para o app Vênus Cine.
Integra IPTV (Xtream Codes) e enriquece metadados com TMDB.

## Instalação

```bash
npm install
```

## Configuração

Copie `.env` e preencha as credenciais:

```env
PORT=3000
IPTV_BASE_URL=http://seu-servidor-iptv.com:8080
IPTV_USERNAME=seu_usuario
IPTV_PASSWORD=sua_senha
TMDB_API_KEY=sua_chave_tmdb
TMDB_LANGUAGE=pt-BR
```

## Rodar

```bash
npm start       # produção
npm run dev     # desenvolvimento (watch)
```

## Rotas

| Método | Rota | Descrição |
|---|---|---|
| GET | `/api/health` | Status do servidor |
| GET | `/api/home` | Home agregada (hero + sections) |
| GET | `/api/movies` | Filmes paginados |
| GET | `/api/movies/hero` | Slide de filmes |
| GET | `/api/movies/search?q=` | Busca filmes |
| GET | `/api/movies/:id` | Detalhes + streamUrl |
| GET | `/api/series` | Séries paginadas |
| GET | `/api/series/hero` | Slide de séries |
| GET | `/api/series/search?q=` | Busca séries |
| GET | `/api/series/:id` | Detalhes + temporadas |
| GET | `/api/series/:id/season/:num` | Episódios da temporada |
| GET | `/api/channels` | Canais ao vivo |
| GET | `/api/categories` | Lista categorias |
| GET | `/api/categories/:name` | Itens da categoria |
| GET | `/api/stream/:id?type=` | URL do stream |
| POST | `/api/admin/refresh-cache` | Atualiza cache |

## Estrutura

```
src/
├── services/
│   ├── cacheService.js     # Cache LRU (200 itens)
│   ├── iptvService.js      # IPTV + filtros
│   └── tmdbService.js      # TMDB enrichment
├── routes/
│   └── apiRoutes.js        # Endpoints
└── server.js               # Entry point
```

## Licença

MIT
