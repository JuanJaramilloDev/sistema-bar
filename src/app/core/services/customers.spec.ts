import { TestBed } from '@angular/core/testing';
import { Customers } from './customers';

describe('Customers', () => {
  let service: Customers;

  beforeEach(() => {
    TestBed.configureTestingModule({});
    service = TestBed.inject(Customers);
  });

  it('should be created', () => {
    expect(service).toBeTruthy();
  });
});
