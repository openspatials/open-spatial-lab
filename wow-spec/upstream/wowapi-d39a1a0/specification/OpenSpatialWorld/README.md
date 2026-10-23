# Spatial World Provisioning

![objects](../figures/objects.svg)

## Core Requirements and Feature   

Open continuous spatial experience and session for a given device and User-Agent/browser (UA) 

| Requirements | Feature | Description |
| --- | --- | --- | 
| Join world | URL, URL#join, URL#join=aspect.id | join the world as new or existing user on a given device and UA |
| Follow world | URL#follow, URL#follow=aspect.id | follow the world as new or existing user |
| Preview world | URL#preview, #preview=aspect.id | experence world without |
| Persist world | store or bookmark URL |
| Share world | send URL to second user |

## Optional Feature

Additional information provided in separate data package

- Read world status including live aspects as a standardized container (e.g JSON-LD)
  - URL/wow/world

- Read and write aspects of the world to enable links to sub-elements of the world (e.g user avatar)
  - URL/wow/user/4182

- Expose parts of scene to be linked in external world 		
  - URL/wow/scene/

- Read and write the structure of scene nodes if this is exposed 
  - URL/wow/scene/node


## OpenAPI spec 

Source 

[API](API.yaml) 

Preview 

[Preview](https://redocly.github.io/redoc/?url=https://raw.githubusercontent.com/WebOfWorlds/WoWAPI/refs/heads/main/specification/OpenSpatialWorld/API.yaml)
