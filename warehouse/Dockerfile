FROM python:3.12-slim
RUN pip install --no-cache-dir dbt-postgres==1.11.0
WORKDIR /usr/app
ENV DBT_PROFILES_DIR=/usr/app
ENTRYPOINT ["dbt"]
