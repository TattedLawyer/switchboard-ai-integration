FROM python:3.12-slim
# dbt-core co-pinned exactly (phase-close F3): dbt-postgres==1.11.0 alone lets dbt-core
# float across majors, and a future major turns today's deprecation warnings
# (MissingArgumentsPropertyInGenericTest, D039) into parse errors. The pin records the
# version this image resolves TODAY — state-recording, not an upgrade (repo exact-pin
# norm: pg-boss). Bump both together, deliberately.
RUN pip install --no-cache-dir dbt-postgres==1.11.0 dbt-core==1.12.0
WORKDIR /usr/app
ENV DBT_PROFILES_DIR=/usr/app
ENTRYPOINT ["dbt"]
